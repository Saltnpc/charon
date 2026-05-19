# Charon Learning + Multi-Strategy Dry-Run Review

Reviewer stance: senior systems architect + quantitative trader. This review is based on the current files in `src/learning/*.js`, `src/pipeline/*.js`, `src/execution/positions.js`, `src/db/positions.js`, and `src/db/settings.js`, plus `implementation_plan.md`.

## Executive Verdict

The plan is directionally right, but the proposed execution order is incomplete. Multi-strategy dry-run should not be implemented before fixing attribution, per-strategy capacity, duplicate semantics, summary reporting, and data-quality logging. Otherwise the 7-day dry-run will produce data that looks larger but is statistically contaminated.

The current code is still architected around one active strategy:

- `src/db/settings.js` `activeStrategy()` returns the first enabled row only.
- `src/pipeline/candidateBuilder.js` `buildCandidate()` stamps `signals.strategy` from `activeStrategy()`.
- `src/pipeline/orchestrator.js` `processCandidateFromSignals()` calls `canOpenMorePositions()` before enrichment, so one full global book can suppress all strategy tests.
- `src/db/positions.js` `createDryRunPosition()` dedupes by `mint` only, so the same token cannot create four strategy positions today.
- `src/execution/positions.js` `refreshCandidateForExecution()` re-filters using the active strategy, not the strategy attached to the position or pending entry.

One important mismatch with the prompt: lessons are already partially injected into the LLM prompt. `src/pipeline/llm.js` has `activeLessonsForPrompt()` and passes `recent_lessons` into `decideCandidateBatch()`. The open loop is therefore not "no injection"; it is "weak, only active lessons, only screening/risk, not applied to dry-run multi-strategy if LLM is skipped, and not converted into controlled policy hypotheses."

## P0 Before Dry-Run

### P0.1 Fix Strategy Attribution End-to-End

The plan's `allActiveStrategies()` and `filterCandidate(candidate, strategyOverride)` are necessary but not sufficient.

Required changes:

- `src/db/settings.js`
  - Add `allActiveStrategies()` as planned.
  - Keep `activeStrategy()` for confirm/live only. Do not rely on first-enabled semantics in dry-run.
- `src/pipeline/candidateBuilder.js`
  - Change `filterCandidate(candidate, strategyOverride = null)`.
  - Add `strategy_id` to the returned filter object and preserve warnings.
  - Do not set `candidate.signals.strategy` once during `buildCandidate()` and then reuse it for all strategies. For multi-strategy, either clone the candidate per strategy with `signals.strategy = strat.id`, or put strategy attribution only in the filter/position snapshot.
- `src/execution/positions.js`
  - Change `refreshCandidateForExecution(row, strategyOverride = null)` and call `filterCandidate(refreshed, strategyOverride)`.
  - Without this, a candidate that passed `degen` can be rejected on fresh check using `sniper`, or vice versa.
- `src/db/positions.js`
  - Change `createDryRunPosition(candidateId, candidate, decision, reason, strategyOverride = null)`.
  - Store the strategy config used at entry inside `snapshot_json`, not only `strategy: strat.id`. Strategy configs can later change, and dry-run replay needs the original parameters.

Data-quality warning: if a position is opened under strategy A but the fresh filter, decision log, or snapshot says strategy B, head-to-head comparison becomes invalid.

### P0.2 Fix Duplicate and Capacity Semantics

The current duplicate check in `createDryRunPosition()` is:

```sql
SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
```

That blocks the main goal: one token tested by up to four strategies.

Required changes:

- In `src/db/positions.js` `createDryRunPosition()`, dedupe on `(mint, strategy_id, status='open')`.
- In `createLivePosition()`, keep mint-only dedupe unless you explicitly want multiple live positions in the same token. For live mode, mint-only is safer.
- In `canOpenMorePositions()`, support `strategyOverride`. During dry-run, count open positions per `strategy_id`; during confirm/live, keep the conservative single-strategy behavior.
- In `src/pipeline/orchestrator.js` `processCandidateFromSignals()`, remove the global pre-enrichment `canOpenMorePositions()` gate for dry-run. Instead, check capacity inside the per-strategy loop.

Data-quality warning: a global max-open check will bias the test toward whichever strategy fills first. That will make later strategies look inactive or lower opportunity, even if their filters are valid.

### P0.3 Rework Multi-Strategy Orchestration

The implementation plan inserts multi-strategy handling right after `buildCandidate()`. That is the right location, but the current orchestrator has LLM batching, candidate status mutation, selected-row logic, fresh execution checks, and Telegram side effects built around one selected candidate.

Recommended dry-run path in `src/pipeline/orchestrator.js` `processCandidateFromSignals()`:

1. Build and upsert one raw candidate.
2. If mode is `dry_run` and multi-strategy is enabled, loop `allActiveStrategies()`.
3. For each strategy:
   - Skip if per-strategy capacity is full.
   - Run `filterCandidate(candidate, strat)`.
   - Store a per-strategy decision event, even for rejects.
   - For passed strategies, create a rule-based decision with fixed `tp/sl` from that strategy.
   - Call `createDryRunPosition(..., strat)`.
4. Return before the LLM batch path.

Do not reuse one `candidate.filters` field for every strategy without storing per-strategy results somewhere. If the final loop iteration overwrites `candidate.filters`, the DB candidate row will misrepresent the strategies that passed earlier.

Recommended structure:

- Add `candidate.strategyFilters = { [strategyId]: filterResult }` before upsert/update.
- Keep `candidate.filters` as the active/single-strategy filter only for legacy paths.

### P0.4 Fix Learning Summary for Strategy Comparison

`src/learning/summary.js` currently summarizes by route, not strategy. That is inadequate for a 4-strategy dry-run.

Add to `summarizeLearningWindow()`:

- `positions.byStrategy`
- `positions.byStrategyRoute`
- `positions.byStrategyMcapBin`
- `positions.byStrategyExitReason`
- open/closed counts per strategy
- win rate
- average and median PnL
- total virtual SOL PnL
- max drawdown proxy per strategy
- average hold time
- SL rate
- TP/trailing/max-hold/manual rate
- missed-upside rate by strategy from `position_outcomes`
- false-signal rate by strategy
- median best post-exit move by strategy

For the Telegram report, update `src/learning/report.js` `learningReportText()` to show a compact league table:

```text
Strategy     Closed  Win%   Avg%   Med%   SOL   SL%   Missed%
sniper       12      42     +8     -3     +0.09 33    25
dip_buy      10      50     +5     +2     +0.05 20    30
smart_money  8       63     +18    +9     +0.14 13    38
degen        15      27     -11    -8     -0.16 53    7
```

Data-quality warning: route-only reporting cannot answer whether strategies work. A route may look good only because one strategy filtered it well.

### P0.5 Partial TP Accounting Is Currently Unsafe

The proposed multi-stage TP dry-run accounting says:

```js
const virtualSellSol = Number(position.size_sol) * (stage.sell / 100);
const remaining = Number(position.size_sol) - virtualSellSol;
```

This is wrong for PnL accounting. If a 0.1 SOL position is up 100% and sells 25%, realized proceeds are about 0.05 SOL, not 0.025 SOL. Reducing `size_sol` loses cost basis/proceeds distinction and corrupts final PnL.

Before adding multi-stage TP, add explicit columns or a ledger model:

- `initial_size_sol`
- `remaining_cost_basis_sol`
- `realized_pnl_sol`
- `remaining_fraction`
- `tp_stage_index`

Then `src/execution/positions.js` `refreshPosition()` should compute:

- realized proceeds for the sold fraction at current value
- realized PnL for that fraction
- remaining cost basis
- unrealized PnL on the remaining fraction
- final total PnL = realized + unrealized

Data-quality warning: if multi-stage TP is implemented by mutating `size_sol`, strategy comparison will be invalid. De-risk this before the dry-run or defer partial TP until after the first clean baseline.

## P1 Should Have

### P1.1 Safety Gate Thresholds

The proposed hard gates are reasonable as first-pass dry-run filters, but they should be logged as both raw values and pass/fail reasons.

Recommended:

- `mintAuthorityDisabled === false`: hard reject.
- `freezeAuthorityDisabled === false`: hard reject.
- `dev_team_hold_rate > 30%`: hard reject for sniper/dip/smart_money.
- `creator_hold_rate > 30%`: hard reject for sniper/dip/smart_money.
- `degen` 50%: acceptable for dry-run only, but label it as high-risk.
- `botHoldersPercentage > 10%`, degen > 15%: reasonable hard gate if Jupiter field semantics are confirmed.
- `fresh_wallet_rate`, `bot_degen_rate`, `top_rat_trader_percentage`, `bundlerStats.holdingPct`: warnings first, not hard gates, until enough local data proves predictive value.

Code target: `src/pipeline/candidateBuilder.js` `filterCandidate()`.

Caution: make sure rates are consistently 0-1 or 0-100. The plan multiplies GMGN rates by 100 for display but compares raw values to `0.30`. That is correct only if GMGN returns fractions.

### P1.2 Holder Concentration Fallback Needs Clear Naming

The plan falls back from Jupiter top-20 organic holder percent to GMGN `top_10_holder_rate`. That is acceptable as a coverage fallback, but the field should not be labeled "top20" after fallback.

Recommended return in `filterCandidate()` warnings/evidence:

- `holder_concentration_source: 'jupiter_top20_organic' | 'gmgn_top10' | 'missing'`
- `holder_concentration_percent`

Code target: `src/pipeline/candidateBuilder.js` `filterCandidate()`.

### P1.3 Lessons to LLM Prompt Are Already Present, But Need Governance

Current implementation:

- `src/learning/lessons.js` stores lessons.
- `storeLearningRun()` marks lessons `active` only if `GHOST_AUTO_ACTIVATE_LESSONS && confidence >= 0.7 && support_count >= 5`.
- `src/pipeline/llm.js` `activeLessonsForPrompt()` injects active screening/risk lessons into `recent_lessons`.

Gaps:

- Lessons do not include `pattern_id` or a stable evidence reference.
- Lessons are not injected into rule-based dry-run paths if the plan skips LLM.
- Lessons are not scoped by route unless the LLM generated route metadata.
- No negative-control or cooldown exists for bad lessons.

Recommendation:

- Keep lesson injection for LLM screening.
- Do not inject exit-policy lessons into buy screening.
- Add `learning_lessons.pattern_id` or include pattern metadata in `evidence_json`.
- Add `/lessons activate|deactivate` controls before enabling broad auto-activation.
- For dry-run multi-strategy where LLM is skipped, treat lessons as report-only, not decision inputs. Otherwise strategies stop being comparable.

### P1.4 Auto-Tuning Should Be Shadow-Mode Only

Do not let patterns directly change TP/SL during the 7-day comparison. It creates a moving target and destroys the experiment.

Recommended:

- Add a `policy_recommendations` table or store recommendations in `learning_patterns.evidence_json`.
- Compute proposed parameter changes daily.
- Include shadow recommendations in Telegram.
- Only apply after manual approval and version the policy.

Code targets:

- `src/learning/patterns.js` `aggregatePattern()`
- `src/learning/review.js` `runAutoReview()`
- optional new `src/learning/policy.js`

Use auto-tuning only after a stable baseline, and require minimums like `sample_size >= 30`, `confidence >= 0.75`, and effect size exceeding fees/slippage/noise.

### P1.5 Route/Strategy Auto-Disable Should Be Guarded

The proposed rule "<15% win rate over 10+ trades" is too aggressive for meme coins. Ten trades is not enough, especially with fat-tailed payoffs where one winner can pay for many losers.

Better dry-run behavior:

- Never auto-disable during the first 7-day comparison.
- Add "shadow disabled" status in reports.
- Require at least 20-30 closed positions for a route+strategy pair.
- Use expectancy, not win rate alone:
  - average PnL
  - median PnL
  - total SOL PnL
  - tail winner frequency
  - max loss / rug rate
  - false-signal rate

Code target: `src/learning/patterns.js`, add group spec for `strategy_route` rather than only separate `route` and `strategy`.

### P1.6 Counterfactual Exit Analysis Should Produce Exit Hypotheses

`src/learning/patterns.js` already has `simulateCounterfactualExits()`, but only stores `hold1hMedian` and `hold3hMedian` in evidence. That is useful but underused.

Recommended:

- Add per-strategy counterfactual metrics to `summary.js`.
- In `patterns.js` `aggregatePattern()`, compare actual median PnL to:
  - hold15m
  - hold1h
  - hold3h
  - hold6h
  - maxPostExit
  - minPostExit
- Emit explicit exit hypotheses:
  - "strategy=smart_money has high missed upside; trailing should arm later"
  - "strategy=degen avoids downside; do not loosen exit"
  - "route=graduated_trending benefits from +1h hold only when entry mcap < 50k"

Do not apply these automatically. Use them to choose the next controlled dry-run config.

## P2 Nice To Have

### P2.1 Shared Ghost Fetching, Separate Position Snapshots

With four positions on the same token, ghost jobs will fetch the same mint four times for similar due times. The DB model should still store snapshots per position because percentages vs entry/exit differ by strategy.

Recommended:

- Keep `ghost_snapshots` per `position_id`.
- Add an in-process cache in `src/learning/ghost.js` `monitorGhostTracking()` keyed by `mint + time_bucket`, maybe 30-60 seconds.
- Reuse the fetched raw snapshot across same-mint jobs in the batch.

This reduces API load without sacrificing per-position outcome attribution.

### P2.2 Add Faster Ghost Intervals for Meme Volatility

Current entry offsets: `0, 5m, 15m, 1h`.
Current post-exit offsets: `15m, 1h, 3h, 6h, 12h, 24h`.

For meme coins, add:

- Entry: `1m`, `3m`, keep `5m`, `15m`, `1h`.
- Post-exit: `5m`, keep `15m`, `1h`, `3h`, `6h`, `12h`, `24h`.

Code target: `src/learning/ghost.js` `ENTRY_OFFSETS`, `POST_EXIT_OFFSETS`.

Reason: many rug/launch dynamics happen inside the first 5 minutes. Waiting until 15m post-exit misses whether a stop was good or late.

### P2.3 Better Telegram Digest

Daily digest should include:

- Strategy league table.
- Best/worst token per strategy.
- Route x strategy matrix.
- Open positions by strategy and current unrealized PnL.
- Ghost pending/classified counts.
- Exit diagnostics:
  - SL rate
  - trailing hit rate
  - missed upside rate
  - rug hit/dodged rate
- Data-quality warnings:
  - missing safety fields
  - GMGN/Jupiter failures
  - stale ghost jobs
  - duplicate-suppressed entries

Code targets:

- `src/learning/summary.js` `summarizeLearningWindow()`
- `src/learning/report.js` `learningReportText()`
- possibly `src/telegram/send.js` if a separate daily digest is added.

## TP Stage Review

The proposed TP thresholds are plausible for meme coins, but only if accounting is fixed.

- `sniper`: +100% sell 25%, +200% sell 25%, trail 50%. Reasonable for asymmetric launch trades.
- `dip_buy`: +50% sell 30%, +100% sell 30%, trail 40%. Reasonable; dip buys usually deserve faster de-risking.
- `smart_money`: +100% sell 25%, +300% sell 25%, trail 50%. Reasonable if entries are truly wallet-confirmed; too loose if smart_money is just a trending proxy.
- `degen`: +50% sell 50%, trail 50% tightly. Reasonable; degen should recover principal quickly.

But the dry-run should first run either:

- fixed single-exit policies for clean baseline, or
- multi-stage TP with correct realized/unrealized accounting from day one.

Do not run broken partial accounting just because it is "virtual"; it is the measurement system.

## Critical Failure Modes Missing From Plan

### Data Leakage Across Strategies

If the same candidate object is mutated repeatedly in a strategy loop, later filters can overwrite earlier filter evidence. Clone or store per-strategy filter maps.

### Strategy Config Drift

`strategyById(position.strategy_id)` in `src/execution/positions.js` loads current config, not entry-time config. If config changes mid-run, open positions may exit under rules they did not enter with.

Recommendation: store entry policy in `snapshot_json.strategy_config` and use that for position lifecycle, or store immutable TP/SL/trailing/stages directly on the position.

### LLM Skip Changes the Experiment

The plan says "LLM saat multi-strategy: Skip (rule-based only)." That is clean for comparison, but it means current lesson injection into `llm.js` is irrelevant for the dry-run. The report should explicitly label this dry-run as testing filters + exits, not LLM screening quality.

### Same Token, Same Price Fetch Burst

Four positions per token plus entry/post-exit ghost jobs can multiply Jupiter/GMGN calls. Batch/cache same-mint refreshes in:

- `src/execution/positions.js` `monitorPositions()`
- `src/learning/ghost.js` `monitorGhostTracking()`

### Missing Rejection Dataset

Only opened/closed positions get rich learning. For strategy comparison, rejected strategy decisions are also important.

Recommendation: log per-strategy rejects with reason counts in `decision_logs`, including safety warnings. Otherwise you cannot distinguish "strategy did not trade because no signals matched" from "strategy was too strict" from "capacity was full."

### Open Position Survivorship Bias

`summary.js` focuses on closed positions. During a 7-day dry-run, many open positions may carry large unrealized gains/losses. Report open unrealized PnL separately by strategy.

## Additional Data To Log

P0/P1 logging fields for dry-run quality:

- strategy_id on every decision log, reject, position, trade, alert.
- per-strategy filter result including warnings.
- raw safety fields and source availability.
- holder concentration source.
- route + source count.
- entry age of token.
- entry liquidity, holder count, top holder concentration.
- spread/slippage proxy if available.
- API source status for GMGN/Jupiter at candidate build and execution refresh.
- whether capacity prevented an entry.
- whether duplicate semantics prevented an entry.
- entry-time strategy config version or full config snapshot.
- realized/unrealized split after partial exits.

## Final Priority Order

1. P0: Strategy attribution, per-strategy filters, per-strategy position creation.
2. P0: Duplicate/capacity semantics for dry-run.
3. P0: Summary/report strategy comparison.
4. P0: Correct partial TP accounting or defer multi-stage TP.
5. P1: Safety gates and holder fallback with raw evidence logging.
6. P1: Pattern group `strategy_route` and counterfactual exit hypotheses.
7. P1: Lessons governance; keep LLM prompt injection but do not let it mutate dry-run policy.
8. P2: Same-mint cache for ghost/position refresh.
9. P2: Faster ghost intervals.
10. P2: Daily digest polish.

## Bottom Line

Run the dry-run as a controlled experiment. The main danger is not losing virtual SOL; it is collecting seven days of contaminated data and trusting it. Multi-strategy parallel is architecturally sound only after the code stops treating "active strategy" as a global singleton in candidate filtering, fresh execution, position capacity, duplicate checks, reporting, and learning attribution.
