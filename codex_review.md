# Codex Review: Deep Dry-Run Learning System Final Plan

## Verdict: Conditional Approval

I approve the direction and most of the architecture. The finalized plan fixes the biggest earlier risks: it uses durable DB-backed jobs, adds entry and post-exit snapshots, separates outcome dimensions, gates lessons by support/confidence, and limits prompt feedback to screening/risk lessons.

However, I would not let implementation start without addressing the critical issues below. They are not conceptual disagreements; they are concrete failure modes in the current Charon codebase.

## Critical Issues

### 1. Ghost job claiming is not concurrency-safe

`getDueGhostJobs(limit)` as described only selects pending jobs. Because `monitorGhostTracking()` will run on `setInterval`, a slow network call can allow a second interval tick to read the same pending jobs before the first marks them completed. This can duplicate API calls and produce conflicting job status writes.

Required fix:

- Add a `processing` status, `claimed_at_ms`, and possibly `locked_by`/`run_id`.
- Replace `getDueGhostJobs()` with an atomic claim operation inside a SQLite transaction:
  - select due pending jobs
  - update them to `processing`
  - return claimed rows
- Treat stale `processing` jobs as retryable if `claimed_at_ms` is older than a timeout.

Without this, idempotent snapshot inserts reduce data corruption but do not prevent duplicate source calls, misleading attempts counts, or failed/completed status races.

### 2. Close writes and ghost scheduling must be transactional

Current close paths in `src/execution/positions.js` and `src/telegram/commands.js` do separate writes:

- update `dry_run_positions`
- insert `dry_run_trades`
- send/report later

The plan says to call `scheduleGhostTracking()` after close. If the process crashes after the close write but before ghost job creation, the position is permanently closed without ghost tracking.

Required fix:

- Wrap the close update, sell trade insert, and post-exit ghost job insert in one `db.transaction()`.
- Use `INSERT OR IGNORE` for jobs so retries/manual duplicate calls remain safe.
- For live exits, keep async `executeLiveSell()` outside the DB transaction, then perform only local DB writes in the transaction.

This same concern applies to entry jobs. The cleanest hook is inside `createDryRunPosition()` and `createLivePosition()` after the position insert, inside the existing transaction. Scheduling entry jobs from `monitorPositions()` is ambiguous and wasteful because the current monitor has no "newly detected open position" state.

### 3. The plan assumes GMGN can run without credentials, but current startup rejects that

`src/config.js` currently throws if `GMGN_ENABLED !== 'false'` and `GMGN_API_KEY` is missing. The plan says GMGN free/no subscription and treats it as an optional fallback. On a fresh VPS with no `GMGN_API_KEY`, Charon will fail startup unless `GMGN_ENABLED=false` is set.

Required fix:

- Either document `GMGN_API_KEY` as required, or change `validateConfig()` and `fetchGmgnTokenInfo()` semantics so GMGN can be disabled/optional cleanly.
- Ghost snapshots must not assume GMGN exists. Jupiter-only snapshots should be valid `partial` or `full` depending on available fields.

### 4. Classification readiness is underspecified

The plan says `getPositionsReadyForClassification()` returns positions closed >24h without an outcome. That is too early in practice: the last post-exit job is due at +24h and may still be pending, processing, retrying, or delayed by downtime.

Required fix:

- Classify when all post-exit jobs for a position are terminal (`completed`, `failed`, `skipped`), or when `closed_at_ms + 24h + retry_grace_ms` has passed.
- Store weak classification if required snapshots are missing, but do not race classification against the final 24h snapshot.

### 5. Pattern persistence is missing

`patterns.js` says each pattern stores sample size, median PnL, confidence, recommendation, and evidence, but Phase 1 does not add a `position_patterns` or equivalent table. `/patterns`, `/suggest`, reports, deduplication, and lesson support counts need persisted pattern rows.

Required fix:

- Add a `position_patterns` table or explicitly make patterns ephemeral and explain how `/patterns` and lesson generation read them.
- If persisted, include `created_at_ms`, `window_ms`, `pattern_type`, `pattern_key`, `sample_size`, `median_pnl_percent`, `confidence`, `recommendation`, and `evidence_json`.

## Missing Details That Will Block Implementation

- Define exact normalized field extraction for Jupiter and GMGN snapshots. Current Jupiter asset fields include `usdPrice`, `mcap`, `fdv`, `liquidity`, `holderCount`, and stats fields on trending rows, but not every asset response has volume in the same shape.
- Define how `source = 'both'` is chosen when Jupiter and GMGN disagree. The implementation needs deterministic precedence for price, mcap, liquidity, and volume.
- Define allowed enum values for `phase`, `status`, `source_status`, `data_quality`, and `primary_outcome`. Do not leave these as ad hoc strings across modules.
- Define jitter behavior for offset `0`. Entry snapshot at offset `0` should probably not jitter later by 30 seconds if the goal is true entry evidence.
- Define how failed snapshots are represented. The current table only stores successful `ghost_snapshots`; failed jobs have `last_error`, but classification may need explicit missing/failed evidence per offset.
- Define whether live positions are included. Existing learning summary filters to dry-run only. The plan should keep ghost learning dry-run-only by default or explicitly separate live execution outcomes from strategy quality.
- Define how manual closes are identified beyond `exit_reason = 'MANUAL'`. Manual closes should be included in reports but excluded from TP/SL tuning and most exit-policy lessons.
- Define HTML escaping and message length limits for new Telegram commands. `/ghost` and `/patterns` can easily exceed Telegram limits if raw evidence is included.
- Define `review_runs` storage or remove "Record review run in DB" from the plan.
- Define lesson activation precisely. Existing `storeLearningRun()` inserts every lesson as `active`; implementation must change that default or auto-review will still poison prompts.

## Implementation Order Risks

The phase order is mostly right, but a few dependencies need to move earlier:

1. Job claiming and transaction boundaries must be implemented in Phase 1/2 before any interval is enabled.
2. Entry job scheduling should be added inside `src/db/positions.js`, not later through `monitorPositions()`.
3. `learning_lessons` schema changes must land before `lessons.js`, `review.js`, or `llm.js` changes that read `lesson_type`, `confidence`, `support_count`, `strategy_id`, or `expires_at_ms`.
4. Pattern storage must exist before `/patterns`, `/suggest`, and ghost-aware lesson generation.
5. `/ghost <id>` should come before auto-review. It is the fastest way to inspect whether snapshots and classifications are sane.
6. LLM prompt filtering should be changed before auto-review starts creating lessons. Otherwise a partial implementation can activate noisy lessons through the existing prompt path.

Recommended adjusted order:

1. Schema, enums, DB helpers, atomic job claiming.
2. Transactional entry and close scheduling hooks.
3. Ghost monitor with reentrancy lock.
4. `/ghost <id>` and stats command.
5. Classification readiness and outcome storage.
6. Summary/report read-only integration.
7. Pattern persistence and `/patterns`.
8. Candidate lesson generation.
9. LLM prompt feedback.

## Concurrency Concerns

### Ghost monitor overlap

`setInterval(() => trackGhost(() => monitorGhostTracking()), GHOST_CHECK_MS)` does not prevent overlap. If one run takes longer than `GHOST_CHECK_MS`, the next run starts while the first is awaiting API calls.

Required mitigation:

- Add an in-process `ghostMonitorRunning` guard.
- Also use DB-level job claiming, because an in-process guard does not protect against accidental multiple PM2 instances or future worker processes.

### Position monitor and ghost monitor share market data sources

`monitorPositions()` and `monitorGhostTracking()` will both call Jupiter and possibly GMGN. GMGN has a serialized queue and configured pacing, but Jupiter has only cache/backoff. Ghost jobs should use small batches and `fetchJupiterAsset(mint, { useCache: false })` carefully; forcing no cache for every ghost snapshot may increase 429s during busy periods.

### Manual close versus auto close

The current manual close path can run while the position monitor is also refreshing/closing a position. Existing code does not have a close lock for dry-run positions. Adding ghost scheduling makes duplicate close attempts more visible.

Required mitigation:

- Close update should include `WHERE id = ? AND status = 'open'`.
- Check `changes` before inserting a sell trade or scheduling ghost jobs.
- For live exits, keep `sellInProgress` protection, but manual live close should also coordinate with it or have its own lock.

### Partial TP is not a final close

The plan mentions `PARTIAL_TP_EXIT`, but current code records partial TP as a sell trade while leaving the position open. Do not schedule post-exit tracking on partial TP unless a final close actually occurs. Partial TP should be a lifecycle event/snapshot annotation, not a ghost close trigger.

## Database Concerns

- WAL mode is already enabled in `initDb()`, which is good.
- `better-sqlite3` is synchronous. Within one Node process, individual DB calls are blocking and effectively serialized, but async intervals can still interleave between awaited network calls.
- Use transactions for multi-write invariants: position close + trade + ghost jobs; position open + buy trade + TP/SL rules + entry ghost jobs; snapshot insert + job completion.
- Do not hold SQLite transactions open across network calls.
- Add `busy_timeout` if external scripts, PM2 duplicates, or CLI tools may write to the same DB.
- `INSERT OR REPLACE` on `ghost_snapshots` can delete and recreate rows, changing `id` and potentially breaking future references. Prefer `ON CONFLICT(position_id, phase, offset_ms) DO UPDATE SET ...`.
- Add `FOREIGN KEY` constraints only if the app enables `PRAGMA foreign_keys = ON`; otherwise they are misleading. Indexes are more important here.
- Add an index for `position_outcomes(classified_at_ms)` if review windows query by time.
- Add an index for `ghost_snapshots(mint, observed_at_ms)` only if cross-position token queries are planned; otherwise the position index is enough.
- Consider a raw JSON retention policy before raw payloads grow. Normalized columns should be the query source.

## Edge Cases Not Covered

- Bot restarts with overdue entry offset `0` jobs: should capture late with `observed_at_ms`, but classification should know it is not true entry evidence.
- Position has null `entry_price` or `entry_mcap`: snapshot ratios cannot be computed; outcome should be `data_quality = weak`.
- Position has null `exit_price` or `exit_mcap`: post-exit ratios cannot be computed reliably.
- Jupiter returns stale cached data after 429. Current `fetchJupiterAsset()` returns cached data on error; ghost learning must mark this as stale/weak or bypass cache.
- Token is unpriced after exit but not rugged. Missing data alone should not become `RUG_HIT` or `RUG_DODGED`.
- Same mint traded multiple times. Tables correctly key by `position_id`, but pattern logic must avoid mixing same-token repeated trades as independent evidence without noting correlation.
- Strategy config changes while a position is open. Classification should use the position's stored TP/SL/trailing fields and snapshot JSON, not current strategy settings.
- `AUTO_REVIEW_MS` can fire while classification is in progress. Review should acquire its own in-process lock or be idempotent.
- LLM lesson generation can time out. Review should still store classification/patterns and send a non-LLM report.
- Telegram command parsing conflict: `/review`, `/patterns`, `/suggest`, and `/ghost` need to be added before generic or overlapping handlers if any are introduced later.
- Large reports can exceed Telegram message limits. Commands should summarize and truncate.
- Time windows should use `closed_at_ms` for outcome windows, not only `opened_at_ms`, otherwise long-held positions can disappear from reports.

## Top 3 Suggestions

### 1. Make job claiming and transactional lifecycle hooks first-class

This is the highest-leverage reliability improvement. Add atomic job claiming, stale processing recovery, and transactions around open/close scheduling before building classification or reports.

### 2. Keep auto-learning disabled until measurement quality is proven

For the first dry-run period, generate classifications, patterns, and candidate lessons, but do not activate prompt lessons automatically. Add a config flag such as `GHOST_AUTO_ACTIVATE_LESSONS=false` defaulting to false.

### 3. Add a small data-quality dashboard before advanced pattern mining

Track snapshot success rate, weak classification rate, median job delay, Jupiter/GMGN failure counts, and stale-cache usage. If the data stream is weak, pattern detection and lesson generation should pause automatically.

## Final Recommendation

Proceed with the plan only after amending it for atomic job claiming, transactional scheduling, GMGN optional startup behavior, classification readiness, and pattern persistence. With those changes, the design is sound enough for dry-run measurement. Without them, the system will appear to work during happy-path testing but will produce missing ghost histories, duplicate polling, premature classifications, and potentially bad LLM feedback.
