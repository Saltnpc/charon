# Deep Dry-Run Learning System: Brutal Analysis

## Existing System Reality

Charon already has a clean but very shallow learning loop:

- `src/app.js` starts the DB, live execution, Telegram, signal ingestion, and one global position monitor interval.
- `src/pipeline/orchestrator.js` builds/enriches candidates, runs rule or LLM selection, and opens dry-run/live positions.
- `src/execution/positions.js` owns live/dry-run position refresh and exit logic. It checks current Jupiter asset data, updates high-water values, decides TP/SL/trailing/max-hold exits, writes the close into `dry_run_positions`, inserts a `dry_run_trades` sell row, and sends Telegram exit messages.
- `src/db/positions.js` inserts dry-run and live positions into the same table: `dry_run_positions`. The table name is misleading now because live positions also live there.
- `src/db/connection.js` is the schema/migration layer. There is no real migrations directory. New tables are added via `CREATE TABLE IF NOT EXISTS` and new columns through `ensureColumn()`.
- `src/learning/summary.js` summarizes closed dry-run positions over a window, grouped mainly by route. It does not know anything about post-exit behavior.
- `src/learning/lessons.js` creates fallback lessons from simple route and SL evidence, optionally asks an LLM to produce up to 6 lessons, and stores all lessons as active.
- `src/pipeline/llm.js` injects active lessons into the candidate screening prompt.
- `/learn` and `/lessons` already exist through `src/learning/commands.js` and `src/telegram/commands.js`.

Important consequence: the current learning loop is not causal. It learns from what happened until exit only. It has no concept of "what would have happened if we held longer", "entry was late", "TP was too low", or "exit protected us from a rug". Your ghost-tracking concept addresses that gap, but the original proposal needs guardrails.

## What Is Wrong Or Impractical

### 1. The thresholds are arbitrary and will create bad lessons

`EXIT_TOO_EARLY: price went >100% higher after exit` sounds intuitive, but it is dangerously naive for meme coins. A token can wick +120% five minutes after exit and then die. If the system labels that as "too early", it will teach the bot to hold garbage longer.

Corrections:

- Use sustained post-exit opportunity, not one tick.
- Track both `max_post_exit_mcap` and `time_above_threshold_ms`.
- Require minimum liquidity/volume at the peak, otherwise ignore wick-only data.
- Compare post-exit upside against risk: a +100% high after first dropping -80% is not a clean missed exit.

Better definition:

```text
MISSED_UPSIDE if:
- max_post_exit_pnl_after_exit >= +100%
- AND at least 2 consecutive snapshots or one candle window confirms it
- AND liquidity is still usable
- AND drawdown before that upside did not exceed configured SL by a large margin
```

### 2. "PERFECT_EXIT" is too easy to over-credit

`PERFECT_EXIT: price dropped >20% within 3h after exit` is only useful if the exit was profitable or avoided further loss. A position can close at -25% SL, then drop another 20%; that is not a perfect exit, it is a normal SL doing its job. Calling it perfect will inflate exit quality.

Better split:

- `PROTECTED_PROFIT`: TP/trailing/manual profit exit followed by meaningful drawdown.
- `LOSS_CONTAINED`: SL exit followed by further major drawdown.
- `NEUTRAL_EXIT`: post-exit movement does not strongly validate or invalidate the exit.

### 3. Classification labels overlap and need precedence

The proposed labels are not mutually exclusive:

- `RUG_DODGED` and `PERFECT_EXIT` can both be true.
- `FALSE_SIGNAL`, `EXIT_TOO_LATE`, and `RUG_HIT` can all describe the same SL.
- `LATE_ENTRY` is not an exit outcome; it is an entry-quality tag.
- `SIDEWAYS` is an exit reason/outcome, not a post-exit classification.

Use separate dimensions instead of one flat label:

```text
entry_tags:        LATE_ENTRY, WEAK_HOLDER_BASE, LOW_VOLUME, OVERCROWDED_HOLDERS
exit_tags:         TOO_EARLY, GOOD_PROFIT_EXIT, TOO_LATE, SIDEWAYS_TIMEOUT, LOSS_CONTAINED
risk_tags:         RUG_DODGED, RUG_HIT, LIQUIDITY_CRASH, DELISTED_OR_UNPRICED
signal_tags:       FALSE_SIGNAL, GOOD_SIGNAL_BAD_EXIT, GOOD_ENTRY_BAD_HOLD_RULE
primary_outcome:   one selected label for reporting only
```

Then choose `primary_outcome` by precedence:

1. `RUG_HIT`
2. `RUG_DODGED`
3. `FALSE_SIGNAL`
4. `EXIT_TOO_LATE`
5. `EXIT_TOO_EARLY`
6. `PROTECTED_PROFIT`
7. `LOSS_CONTAINED`
8. `SIDEWAYS`
9. `NEUTRAL`

### 4. Ghost tracking only after closed positions misses the most important counterfactual

If you only track after exit, you can judge exits but not entries. You also need an entry-time path:

- What happened in the first 15m/1h/3h after entry?
- Was the LLM right but TP/SL bad?
- Was the entry late at the moment of buy?
- Did the bot buy before liquidity became tradable?

The existing `dry_run_positions.high_water_mcap` captures high while open, but it is updated only while the position remains open and from current Jupiter asset data. It does not preserve a time series. You need lifecycle snapshots from open through +24h after close.

Minimum fix:

- Start snapshots at position open, not only close.
- Store phase as `open_monitor` or `post_exit`.
- Reuse the same snapshot table for both.

### 5. API schedule will silently drift and miss exact snapshots

The concept says snapshot at +15m, +1h, etc. In this codebase, `setInterval()` loops are used and DB polling is simple. If the process is down at +15m, you will miss that exact snapshot unless the scheduler stores due work in the DB.

Do not implement ghost tracking as in-memory timers. This bot already persists state in SQLite and can restart. Use a table with due timestamps and status. Every monitor tick or separate interval queries due rows.

### 6. Jupiter/GMGN data is not reliable enough to be the sole truth

`refreshPosition()` currently uses `fetchJupiterAsset(position.mint)` and falls back to old `high_water_price`/`entry_price`. That fallback is fine for "do not crash", but it is dangerous for learning. If Jupiter fails and you reuse stale high-water data, the model may learn fake stability.

Ghost snapshots need explicit data quality:

- `source`
- `source_status`
- `is_stale`
- `observed_at_ms`
- `requested_for_ms`
- `error`
- `price_usd`
- `mcap_usd`
- `liquidity_usd`
- `volume fields if available`

Never classify from stale fallback values unless marked as weak evidence.

### 7. "liquidity crash" is not currently available at close

The existing close logic writes `exit_price`, `exit_mcap`, and PnL. It does not write exit liquidity. `refreshPosition()` has access to `asset`, but only stores mcap/price in the position. If you want `RUG_HIT` or `RUG_DODGED`, you need liquidity snapshots before/after exit.

Jupiter asset rows include `liquidity`; GMGN token info also appears to expose `liquidity`. Store it.

### 8. "had TP opportunity but ended at SL" is only partially available

`dry_run_positions.high_water_mcap` tells you if mcap exceeded entry. But with trailing enabled, TP being hit arms trailing instead of exiting. A position could hit TP and then exit at trailing TP, not SL. Also partial TP can happen. The current schema has `partial_tp_done`, but learning summary ignores it.

Correct definition:

```text
EXIT_TOO_LATE if:
- exit_reason = 'SL'
- high_water_mcap implied max_pnl >= configured tp_percent
- trailing_enabled = false OR trailing/partial rules failed to realize profit
- enough open-monitor snapshots confirm this was not a one-poll bad print
```

### 9. "entry was >70% of ATH" needs current chart semantics fixed

`compactCandidateForLlm()` already gives ATH/range context from `candidate.chart`. It uses 24h, 7d, and 30d windows from Jupiter chart data in native price. But "ATH" here is not true all-time high; it is a rolling range high. For fresh pump tokens that may be close enough, but the label must be honest.

Use `ENTRY_NEAR_RANGE_HIGH`, not `LATE_ENTRY`, unless you have true ATH from a trusted source. If you keep `LATE_ENTRY`, define it as:

```text
entry_mcap >= 0.70 * max(range_high_mcap_24h_or_30d)
```

and store the exact range window used.

### 10. Auto-generating lessons every 6 hours can poison the prompt

Right now `storeLearningRun()` inserts every generated lesson as active. `activeLessonsForPrompt()` blindly includes the latest 6 active lessons in every screening prompt. If you auto-run every 6h and generate lessons from small samples, noisy outcomes will rapidly steer the LLM in random directions.

You need lesson quality gates:

- minimum closed positions, e.g. 20 overall or 5 per route/pattern
- confidence score on the lesson
- evidence sample size
- expiration/decay
- deduplication
- manual review or "candidate lesson" status before active

Do not let a 6-hour window with 3 trades rewrite the bot's behavior.

### 11. Pattern detection from dry-run data will overfit fast

"Best time of day", "mcap sweet spots", and "optimal TP levels" sound useful, but with meme coins the sample size needed is large. Over a few weeks, your data may still be dominated by market regime, API outages, and selection bias from current filters.

Add support, confidence intervals, and out-of-sample validation before making recommendations. A pattern with 4 wins out of 5 is not a law; it is a hypothesis.

### 12. Data volume is manageable, but JSON bloat and indexing matter

Six post-exit snapshots per position is tiny. Even 500 positions/week is 3,000 snapshots/week. The real bloat comes if you store full raw API payloads in every row. Better approach:

- store normalized scalar columns for queries
- store compact raw JSON only when useful
- prune or archive raw payloads after N days
- index due work and common query columns

SQLite can handle this easily if tables are indexed.

## What Is Missing

### 1. A position lifecycle event model

You need explicit lifecycle hooks:

- position opened
- partial TP happened
- TP armed trailing
- position closed
- ghost tracking started
- ghost tracking completed
- classification completed
- lesson candidate generated

The current system has trades and position fields, but no event stream. `decision_logs` are entry-focused. You can add `position_events` or use snapshot/tracking tables with status fields.

### 2. A scheduler that survives restarts

Do not rely on `setTimeout()` per position. Persist jobs:

```sql
CREATE TABLE ghost_tracking_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  phase TEXT NOT NULL,
  offset_ms INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  completed_at_ms INTEGER,
  UNIQUE(position_id, phase, offset_ms)
);
CREATE INDEX idx_ghost_jobs_due ON ghost_tracking_jobs(status, due_at_ms);
```

### 3. A normalized snapshot table

Recommended table:

```sql
CREATE TABLE ghost_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  phase TEXT NOT NULL,
  offset_ms INTEGER NOT NULL,
  requested_for_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_status TEXT NOT NULL,
  price_usd REAL,
  mcap_usd REAL,
  liquidity_usd REAL,
  volume_5m_usd REAL,
  volume_1h_usd REAL,
  holder_count INTEGER,
  top20_holder_percent REAL,
  price_change_from_entry_pct REAL,
  price_change_from_exit_pct REAL,
  mcap_change_from_entry_pct REAL,
  mcap_change_from_exit_pct REAL,
  data_quality TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(position_id, phase, offset_ms)
);
CREATE INDEX idx_ghost_snapshots_position ON ghost_snapshots(position_id, phase, offset_ms);
CREATE INDEX idx_ghost_snapshots_mint ON ghost_snapshots(mint, observed_at_ms);
```

### 4. Classification storage

Do not hide classifications inside a JSON blob only. Store queryable columns:

```sql
CREATE TABLE position_outcomes (
  position_id INTEGER PRIMARY KEY,
  classified_at_ms INTEGER NOT NULL,
  primary_outcome TEXT NOT NULL,
  entry_score REAL NOT NULL,
  exit_score REAL NOT NULL,
  total_score REAL NOT NULL,
  entry_tags_json TEXT NOT NULL,
  exit_tags_json TEXT NOT NULL,
  risk_tags_json TEXT NOT NULL,
  signal_tags_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE INDEX idx_position_outcomes_primary ON position_outcomes(primary_outcome, classified_at_ms);
```

### 5. Manual review state

Some classifications will be wrong. Add status:

```text
auto_classified -> reviewed -> accepted/rejected
```

At minimum, store `review_status` and `review_note` in `position_outcomes`.

### 6. Baseline comparison

The bot needs counterfactual strategies:

- current strategy actual exit
- hold 15m
- hold 1h
- hold 3h
- fixed TP 30/50/100
- trailing 10/20/30
- sell half at TP and trail rest

Without this, "optimal TP" is guesswork. Compute simulated exits from the same snapshot/candle path.

### 7. Market regime context

Meme coin behavior depends heavily on SOL price, broad risk appetite, launchpad meta, and time-of-day liquidity. Store at least:

- SOL/USD at entry and exit
- source route
- strategy id
- launchpad
- token age
- signal source count
- LLM confidence
- current active filters

Some of this already exists in `snapshot_json`, but pattern queries should normalize the most important fields into columns or materialized summaries.

## Corrected Design

### Phase 1: Snapshot and classify, do not auto-change behavior

Start by collecting data and reporting. Do not feed new lessons into the live LLM prompt until classifications stabilize.

Implement:

- `src/db/ghost.js`: table helpers and job creation.
- `src/learning/ghost.js`: snapshot fetch, classification, score calculation.
- `startGhostTracking(position)` called after any close path.
- `monitorGhostTracking()` interval in `src/app.js`.
- `/ghost <id>` command.
- Extend `/learn` summary to include ghost outcomes when present.

### Phase 2: Add pattern mining with support thresholds

Only after you have enough classified positions:

- bin by mcap, route, strategy, token age, holder concentration, time of day
- require minimum support per bin
- compare bins by median PnL and downside, not just average
- produce "suggestions" as hypotheses, not active rules

### Phase 3: Promote high-confidence lessons

Add a lesson status pipeline:

```text
candidate -> active -> expired/rejected
```

Only active lessons should enter `activeLessonsForPrompt()`. Auto-review should create candidate lessons unless support is high.

## Code-Level Integration

### 1. Hook ghost tracking into all close paths

There are three close paths:

- dry-run auto close in `src/execution/positions.js`
- live auto close in `src/execution/positions.js`
- manual close in `src/telegram/commands.js`

Do not duplicate scheduling logic. Add:

```js
// src/learning/ghost.js
export function scheduleGhostTracking(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!position || position.status !== 'closed') return;
  createGhostJobs(position);
}
```

Then call it immediately after the `UPDATE dry_run_positions SET status = 'closed'...` transaction and trade insert.

Better: wrap the close DB update, trade insert, and ghost job creation in one transaction so a crash does not close a position without scheduling tracking.

### 2. Avoid calling async code inside SQLite transactions

The code already fetches prices before DB writes. Keep it that way. DB transactions should only do local writes. Fetch Jupiter/GMGN outside, then write snapshot rows in a transaction.

### 3. Add a polling loop in `app.js`

Use a separate interval, not the existing position monitor, because ghost tracking has different cadence and failure behavior.

```js
import { monitorGhostTracking } from './learning/ghost.js';

const trackGhost = makeFailureTracker('ghost tracking', (msg) => sendTelegram(msg));
setInterval(() => trackGhost(() => monitorGhostTracking()), GHOST_CHECK_MS);
```

Add config:

```js
export const GHOST_CHECK_MS = Number(process.env.GHOST_CHECK_MS || 30_000);
export const GHOST_MAX_ATTEMPTS = Number(process.env.GHOST_MAX_ATTEMPTS || 5);
```

### 4. Use durable due jobs

Offsets:

```js
const POST_EXIT_OFFSETS = [
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];
```

Also add open lifecycle offsets:

```js
const ENTRY_OFFSETS = [
  0,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];
```

Open snapshots can be scheduled in `createDryRunPosition()`/`createLivePosition()` or the first time the position monitor sees a new open position. If you want clean code, call a scheduler from the orchestrator after position creation.

### 5. Snapshot fetch function

Use both Jupiter and GMGN opportunistically:

```js
async function fetchGhostMarketSnapshot(mint) {
  const [asset, gmgn] = await Promise.allSettled([
    fetchJupiterAsset(mint, { useCache: false }),
    fetchGmgnTokenInfo(mint, false),
  ]);

  // Normalize with explicit source quality.
}
```

Current GMGN code queues requests and has pacing/backoff. Jupiter has asset cache and 429 backoff. Use these existing mechanisms rather than creating raw axios calls.

Do not fail the whole job if one source fails. Store partial data:

```text
source_status = "jupiter_ok_gmgn_failed"
data_quality = "partial"
```

### 6. Classify only after enough snapshots

Run classification when either:

- all post-exit jobs are complete, or
- the last due offset is older than 24h + retry grace.

Add:

```js
export function classifyDueGhostOutcomes() {
  const rows = db.prepare(`
    SELECT p.*
    FROM dry_run_positions p
    LEFT JOIN position_outcomes o ON o.position_id = p.id
    WHERE p.status = 'closed'
      AND o.position_id IS NULL
      AND p.closed_at_ms <= ?
  `).all(now() - 24 * 60 * 60_000);
}
```

### 7. Scoring should be decomposed

Do not create one mysterious 0-100 score. Store components:

```text
entry_score:
- timing_vs_range: 0-25
- liquidity_quality: 0-20
- holder_distribution: 0-20
- signal_strength: 0-20
- early_path_confirmation: 0-15

exit_score:
- captured_available_upside: 0-30
- avoided_drawdown: 0-25
- respected_strategy_rules: 0-20
- post_exit_validation: 0-15
- execution/data_quality_penalty: -10 to 0

total_score = weighted blend
```

For live positions, separate strategy quality from execution quality. Slippage, failed sells, and wallet PnL should not be mixed with dry-run signal quality.

### 8. Pattern table should store computed aggregates, not every raw observation

Suggested:

```sql
CREATE TABLE position_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  win_rate REAL,
  avg_pnl_percent REAL,
  median_pnl_percent REAL,
  avg_entry_score REAL,
  avg_exit_score REAL,
  false_signal_rate REAL,
  missed_upside_rate REAL,
  rug_rate REAL,
  confidence REAL NOT NULL,
  recommendation TEXT,
  evidence_json TEXT NOT NULL,
  UNIQUE(window_ms, pattern_type, pattern_key, created_at_ms)
);
CREATE INDEX idx_position_patterns_type ON position_patterns(pattern_type, confidence, sample_size);
```

Pattern examples:

- `route=graduated_trending`
- `entry_mcap_bin=25k_50k`
- `ath_distance_bin=0_15_pct_below_high`
- `hour_utc=13`
- `strategy=sniper`
- `tp_percent=50`

### 9. Telegram commands

Add to `src/telegram/commands.js`:

- `/ghost <id>`: show snapshots, outcome tags, scores, and post-exit max/min.
- `/patterns [window]`: show high-support patterns only.
- `/suggest [window]`: show proposed config changes, not auto-apply.
- `/review <window>`: run a ghost-aware learning report. This can wrap or replace `/learn`.

Keep `/learn` for current behavior or make it call `/review` internally once ghost tracking exists.

## Edge Cases

### API failures

Handling:

- retry jobs with exponential backoff
- cap attempts
- store `failed` jobs with `last_error`
- classify with `data_quality = weak` if fewer than N valid snapshots
- never use stale fallback data as strong evidence

If Jupiter returns null but GMGN has usable data, store a partial snapshot. If both fail, store a failed job but leave position eligible for weak classification later.

### Delisted/unpriced tokens

A delisted token may return no Jupiter asset. That is itself evidence, but not the same as price = zero.

Use tags:

- `UNPRICED_AFTER_EXIT`
- `DELISTED_OR_UNINDEXED`
- `POSSIBLE_RUG`

Only label `RUG_HIT`/`RUG_DODGED` if liquidity collapse, price collapse, or holder/market data supports it. Missing data alone is weak evidence.

### Rate limits

GMGN already has a queue and pacing. Jupiter has asset 429 backoff. Ghost tracking should:

- process due jobs in small batches, e.g. 5-10 per interval
- avoid fetching holders on every ghost snapshot; holders are expensive and usually unnecessary post-exit
- fetch chart windows only for classification if snapshots are too sparse
- add jitter to scheduled due times to avoid bursts

### Overlapping classifications

Use multi-tag classification plus one primary outcome. Store all tags. Reports can show:

```text
Primary: EXIT_TOO_EARLY
Tags: ENTRY_NEAR_RANGE_HIGH, MISSED_UPSIDE, GOOD_SIGNAL_BAD_EXIT
```

### Data volume over weeks

At 1,000 positions/week and 10 snapshots/position, you get 10,000 snapshot rows/week. SQLite is fine with indexes. The risk is raw JSON size.

Policy:

- keep normalized columns forever
- keep compact raw JSON for 30-90 days
- optionally null out raw JSON for old snapshots after extracting metrics
- run `VACUUM` manually if DB size matters

### Bot restarts

All tracking jobs must be persisted. On startup, `monitorGhostTracking()` should pick up overdue pending jobs. Jobs should be idempotent through `UNIQUE(position_id, phase, offset_ms)`.

### Duplicate positions by mint

Current insert logic only prevents duplicate open positions for the same mint. You can have multiple closed positions for the same mint over time. Ghost tables must key by `position_id`, not mint.

### Manual closes

Manual closes are important learning events. A manual close may reflect human discretion, not strategy exit rules. Tag them:

```text
exit_reason = MANUAL
exit_policy = human_override
```

Do not use manual closes to tune TP/SL unless explicitly included.

### Live positions

Learning summary currently filters to dry-run:

```sql
AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
```

Keep dry-run and live analysis separate. Live results include execution friction, failed routes, slippage, and wallet-specific PnL. They are valuable but should not be mixed into dry-run strategy quality by default.

## Integration With Existing Learning

### `summary.js`

Extend `summarizeLearningWindow()` with ghost-aware aggregates:

```js
const outcomes = db.prepare(`
  SELECT o.*, p.mint, p.symbol, p.opened_at_ms, p.exit_reason, p.pnl_percent, p.strategy_id, p.snapshot_json
  FROM position_outcomes o
  JOIN dry_run_positions p ON p.id = o.position_id
  WHERE p.opened_at_ms >= ?
    AND COALESCE(p.execution_mode, 'dry_run') = 'dry_run'
`).all(cutoff);
```

Add:

```js
ghost: {
  classified,
  pending,
  byPrimaryOutcome,
  avgEntryScore,
  avgExitScore,
  missedUpsideRate,
  rugDodgedRate,
  falseSignalRate,
  lateEntryRate,
  bestExitQuality,
  worstExitQuality,
}
```

Do not break existing report fields. Add the ghost block alongside `positions` and `llm`.

### `lessons.js`

Update fallback lessons to use ghost evidence only with support thresholds:

```js
if (summary.ghost.classified >= 20 && summary.ghost.missedUpsideRate > 35) {
  lessons.push({
    lesson: 'Recent exits often left confirmed post-exit upside; test wider trailing or staged profit-taking before raising TP globally.',
    evidence: summary.ghost.byPrimaryOutcome.EXIT_TOO_EARLY,
    confidence: 0.6,
    status: 'candidate',
  });
}
```

Critical: lessons must distinguish "screening lessons" from "exit management lessons". The LLM screening prompt currently decides whether to buy. It cannot directly manage exits except by suggesting TP/SL. Feeding it "hold longer after TP" as a screening lesson is muddled.

Recommended categories:

```text
lesson_type = screening | risk | exit_policy | sizing | data_quality
```

Only `screening` and maybe `risk` lessons should enter `activeLessonsForPrompt()` by default.

### `llm.js`

Change `activeLessonsForPrompt()` to filter:

```sql
WHERE status = 'active'
  AND lesson_type IN ('screening', 'risk')
```

Also include evidence confidence if present. Do not stuff 6 vague lessons into the prompt. Prefer 3 high-confidence lessons.

### `report.js`

Add ghost lines:

```text
Ghost classified: 18/24
Outcomes: TOO_EARLY 5, LOSS_CONTAINED 4, FALSE_SIGNAL 3
Avg entry/exit score: 61 / 54
Missed upside: 28%
```

### Auto-review every 6 hours

Add `src/learning/review.js`:

- runs `summarizeLearningWindow(24h or 72h)`
- classifies any due outcomes first
- generates pattern candidates
- sends report
- stores run

But do not automatically activate all lessons. Use candidate lessons unless thresholds are met.

## Additional Ideas

### 1. Counterfactual exit simulator

For every closed position, simulate:

- fixed TP/SL combinations
- trailing stop variants
- max hold variants
- partial TP variants

Then report which policy would have improved median outcome. This is more useful than "price went higher later".

### 2. Regret decomposition

Classify why a trade lost:

- bad entry
- bad exit
- bad signal
- rug/systemic risk
- data/API failure
- execution failure

This prevents one bad label from teaching the wrong subsystem.

### 3. Confidence-weighted lessons

Each lesson should include:

- support count
- effect size
- confidence
- expiry
- affected strategy
- affected route

Example:

```text
For sniper route=fee_claim+trending, entries within 10% of 24h range high had 42% false-signal rate over 31 trades. Lower confidence threshold is not the issue; entry timing is.
```

### 4. Strategy shadow testing

Keep current strategy unchanged but simulate proposed parameter changes on new positions for a week:

- `sniper_current`
- `sniper_tp75_trail20`
- `sniper_partial50_at100`

Store shadow outcomes without opening extra positions.

### 5. Data quality dashboard

Track API health:

- snapshot success rate by source
- rate-limit count
- median delay from due time to observed time
- percent weak classifications

If 40% of snapshots are weak, learning should pause.

### 6. Candidate rejection ghosting

The biggest missing learning set is rejected candidates. The bot only learns from buys. That creates selection bias. For every high-confidence WATCH/PASS or filtered candidate, sample a small percentage for ghost tracking as "paper no-buy".

This answers:

- Did the bot correctly pass?
- Are filters too strict?
- Is the LLM missing winners?

Add `ghost_subject_type = position | rejected_candidate`.

### 7. Route-specific lesson pools

Do not let lessons from `degen` contaminate `smart_money`. Store `strategy_id` and `route` on lessons, then retrieve prompt lessons matching the active strategy and candidate route.

### 8. Use medians and downside, not averages

Meme coin PnL has insane outliers. Average PnL lies. Reports should include:

- median PnL
- p25/p75
- worst drawdown
- rug rate
- missed-upside rate
- sample size

## Recommended Minimal Implementation Order

1. Add `ghost_tracking_jobs`, `ghost_snapshots`, and `position_outcomes` tables in `src/db/connection.js`.
2. Add `src/db/ghost.js` for DB helpers.
3. Add `src/learning/ghost.js` for scheduling, snapshot fetch, and classification.
4. Call `scheduleGhostTracking(position.id)` from both auto-close branches in `src/execution/positions.js` and manual close in `src/telegram/commands.js`.
5. Add `GHOST_CHECK_MS` config and `monitorGhostTracking()` interval in `src/app.js`.
6. Add `/ghost <id>` command.
7. Extend `summary.js` and `report.js` to show ghost outcomes.
8. Update `lessons.js` to generate ghost-aware candidate lessons with support thresholds.
9. Add `/patterns`, `/suggest`, and `/review` only after the data is trustworthy.

## Final Verdict

The concept is directionally right, but the first version is too eager to label, score, and auto-learn. The dangerous part is not storage or API polling; that is straightforward. The dangerous part is turning noisy, sparse, post-exit meme coin movement into prompt instructions. If you implement this without data quality flags, classification precedence, support thresholds, and lesson gating, the bot will learn superstition.

Build ghost tracking first as measurement infrastructure. Treat every generated pattern as a hypothesis until it has sample size and survives a later window. Feed only high-confidence, route/strategy-scoped screening lessons into the LLM prompt. Keep exit-policy lessons separate from buy-screening lessons. That separation is the difference between useful dry-run learning and an overfit feedback loop.
