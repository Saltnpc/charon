import { db } from './connection.js';
import { now } from '../utils.js';
import { GHOST_MAX_ATTEMPTS, GHOST_STALE_CLAIM_MS } from '../config.js';

// ── Enums ────────────────────────────────────────────────────────────
export const PHASES = /** @type {const} */ ({ ENTRY: 'entry', POST_EXIT: 'post_exit' });
export const JOB_STATUS = /** @type {const} */ ({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

// ── Ghost Job Helpers ────────────────────────────────────────────────

const _insertJob = db.prepare(`
  INSERT OR IGNORE INTO ghost_tracking_jobs
    (position_id, mint, phase, offset_ms, due_at_ms, status, max_attempts)
  VALUES (?, ?, ?, ?, ?, 'pending', ?)
`);

/**
 * Create ghost tracking jobs for a position.
 * Jitter ±30s is added to non-zero offsets to avoid burst.
 * Offset 0 never jitters (entry evidence).
 */
export function createGhostJobs(positionId, mint, phase, baseTimeMs, offsets) {
  const insert = db.transaction(() => {
    for (const offset of offsets) {
      const jitter = offset === 0 ? 0 : Math.round((Math.random() - 0.5) * 60_000);
      const dueAt = baseTimeMs + offset + jitter;
      _insertJob.run(positionId, mint, phase, offset, dueAt, GHOST_MAX_ATTEMPTS);
    }
  });
  insert();
}

/**
 * Atomic job claiming: SELECT + UPDATE to 'processing' in one transaction.
 * Also reclaims stale processing jobs (claimed > GHOST_STALE_CLAIM_MS ago).
 */
export function claimDueGhostJobs(limit) {
  const ts = now();
  const staleThreshold = ts - GHOST_STALE_CLAIM_MS;

  return db.transaction(() => {
    // Reclaim stale processing jobs first
    db.prepare(`
      UPDATE ghost_tracking_jobs
      SET status = 'pending', claimed_at_ms = NULL
      WHERE status = 'processing' AND claimed_at_ms < ?
    `).run(staleThreshold);

    // Select due pending jobs
    const jobs = db.prepare(`
      SELECT * FROM ghost_tracking_jobs
      WHERE status = 'pending' AND due_at_ms <= ?
      ORDER BY due_at_ms ASC
      LIMIT ?
    `).all(ts, limit);

    if (jobs.length === 0) return [];

    // Atomically claim them
    const ids = jobs.map(j => j.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      UPDATE ghost_tracking_jobs
      SET status = 'processing', claimed_at_ms = ?
      WHERE id IN (${placeholders})
    `).run(ts, ...ids);

    return jobs;
  })();
}

const _markCompleted = db.prepare(`
  UPDATE ghost_tracking_jobs
  SET status = 'completed', completed_at_ms = ?, last_error = NULL
  WHERE id = ?
`);

export function markJobCompleted(jobId) {
  _markCompleted.run(now(), jobId);
}

const _markFailed = db.prepare(`
  UPDATE ghost_tracking_jobs
  SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
      attempts = attempts + 1,
      last_error = ?,
      claimed_at_ms = NULL
  WHERE id = ?
`);

export function markJobFailed(jobId, error) {
  _markFailed.run(String(error).slice(0, 500), jobId);
}

export function skipJob(jobId) {
  db.prepare(`UPDATE ghost_tracking_jobs SET status = 'skipped' WHERE id = ?`).run(jobId);
}

// ── Snapshot Helpers ─────────────────────────────────────────────────

const _upsertSnapshot = db.prepare(`
  INSERT INTO ghost_snapshots
    (position_id, mint, phase, offset_ms, requested_for_ms, observed_at_ms,
     source, source_status, data_quality, price_usd, mcap_usd, liquidity_usd,
     volume_usd, price_vs_entry_pct, price_vs_exit_pct, mcap_vs_entry_pct,
     mcap_vs_exit_pct, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(position_id, phase, offset_ms) DO UPDATE SET
    observed_at_ms = excluded.observed_at_ms,
    source = excluded.source,
    source_status = excluded.source_status,
    data_quality = excluded.data_quality,
    price_usd = excluded.price_usd,
    mcap_usd = excluded.mcap_usd,
    liquidity_usd = excluded.liquidity_usd,
    volume_usd = excluded.volume_usd,
    price_vs_entry_pct = excluded.price_vs_entry_pct,
    price_vs_exit_pct = excluded.price_vs_exit_pct,
    mcap_vs_entry_pct = excluded.mcap_vs_entry_pct,
    mcap_vs_exit_pct = excluded.mcap_vs_exit_pct,
    raw_json = excluded.raw_json
`);

export function insertGhostSnapshot(data) {
  _upsertSnapshot.run(
    data.position_id, data.mint, data.phase, data.offset_ms,
    data.requested_for_ms, data.observed_at_ms,
    data.source, data.source_status, data.data_quality,
    data.price_usd ?? null, data.mcap_usd ?? null,
    data.liquidity_usd ?? null, data.volume_usd ?? null,
    data.price_vs_entry_pct ?? null, data.price_vs_exit_pct ?? null,
    data.mcap_vs_entry_pct ?? null, data.mcap_vs_exit_pct ?? null,
    data.raw_json ?? null,
  );
}

export function getSnapshotsForPosition(positionId, phase = null) {
  if (phase) {
    return db.prepare(`
      SELECT * FROM ghost_snapshots
      WHERE position_id = ? AND phase = ?
      ORDER BY offset_ms ASC
    `).all(positionId, phase);
  }
  return db.prepare(`
    SELECT * FROM ghost_snapshots
    WHERE position_id = ?
    ORDER BY phase ASC, offset_ms ASC
  `).all(positionId);
}

// ── Classification Readiness ─────────────────────────────────────────

const CLASSIFICATION_GRACE_MS = 30 * 60_000; // 30 min grace after last job

/**
 * Returns positions ready for classification: all post_exit jobs terminal,
 * or closed_at_ms + 24h + grace has passed (timeout classification).
 */
export function getPositionsReadyForClassification() {
  const ts = now();
  return db.prepare(`
    SELECT p.id, p.mint, p.symbol, p.closed_at_ms, p.entry_price, p.exit_price,
           p.entry_mcap, p.exit_mcap, p.high_water_price, p.high_water_mcap,
           p.pnl_percent, p.exit_reason,
           p.strategy_id, p.tp_percent, p.sl_percent, p.snapshot_json
    FROM dry_run_positions p
    WHERE p.status = 'closed'
      AND p.id NOT IN (SELECT position_id FROM position_outcomes)
      AND (
        -- All post_exit jobs are terminal
        EXISTS (
          SELECT 1 FROM ghost_tracking_jobs j
          WHERE j.position_id = p.id AND j.phase = 'post_exit'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ghost_tracking_jobs j
          WHERE j.position_id = p.id AND j.phase = 'post_exit'
            AND j.status IN ('pending', 'processing')
        )
        -- Or timeout: closed > 24h + grace ago
        OR p.closed_at_ms < ?
      )
  `).all(ts - 24 * 3600_000 - CLASSIFICATION_GRACE_MS);
}

// ── Outcome Helpers ──────────────────────────────────────────────────

const _upsertOutcome = db.prepare(`
  INSERT INTO position_outcomes
    (position_id, classified_at_ms, primary_outcome, entry_score, exit_score,
     total_score, entry_tags_json, exit_tags_json, risk_tags_json, signal_tags_json,
     max_price_after_exit, min_price_after_exit, missed_upside_pct, avoided_downside_pct,
     data_quality, snapshot_count, review_status, metrics_json, evidence_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(position_id) DO UPDATE SET
    classified_at_ms = excluded.classified_at_ms,
    primary_outcome = excluded.primary_outcome,
    entry_score = excluded.entry_score,
    exit_score = excluded.exit_score,
    total_score = excluded.total_score,
    entry_tags_json = excluded.entry_tags_json,
    exit_tags_json = excluded.exit_tags_json,
    risk_tags_json = excluded.risk_tags_json,
    signal_tags_json = excluded.signal_tags_json,
    max_price_after_exit = excluded.max_price_after_exit,
    min_price_after_exit = excluded.min_price_after_exit,
    missed_upside_pct = excluded.missed_upside_pct,
    avoided_downside_pct = excluded.avoided_downside_pct,
    data_quality = excluded.data_quality,
    snapshot_count = excluded.snapshot_count,
    review_status = excluded.review_status,
    metrics_json = excluded.metrics_json,
    evidence_json = excluded.evidence_json
`);

export function insertPositionOutcome(data) {
  _upsertOutcome.run(
    data.position_id, data.classified_at_ms, data.primary_outcome,
    data.entry_score ?? null, data.exit_score ?? null, data.total_score ?? null,
    data.entry_tags_json, data.exit_tags_json, data.risk_tags_json, data.signal_tags_json,
    data.max_price_after_exit ?? null, data.min_price_after_exit ?? null,
    data.missed_upside_pct ?? null, data.avoided_downside_pct ?? null,
    data.data_quality, data.snapshot_count, data.review_status || 'auto',
    data.metrics_json || '{}', data.evidence_json || '{}',
  );
}

export function getOutcomeForPosition(positionId) {
  return db.prepare('SELECT * FROM position_outcomes WHERE position_id = ?').get(positionId);
}

export function getRecentOutcomes(limit = 50) {
  return db.prepare(`
    SELECT o.*, p.mint, p.symbol, p.pnl_percent, p.exit_reason, p.strategy_id
    FROM position_outcomes o
    JOIN dry_run_positions p ON p.id = o.position_id
    ORDER BY o.classified_at_ms DESC
    LIMIT ?
  `).all(limit);
}

export function getOutcomeCounts() {
  return db.prepare(`
    SELECT primary_outcome, COUNT(*) as count
    FROM position_outcomes
    GROUP BY primary_outcome
  `).all();
}

// ── Stats ────────────────────────────────────────────────────────────

export function ghostStats() {
  const jobCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM ghost_tracking_jobs GROUP BY status
  `).all();
  const classified = db.prepare('SELECT COUNT(*) as count FROM position_outcomes').get().count;
  const unclassified = db.prepare(`
    SELECT COUNT(*) as count FROM dry_run_positions
    WHERE status = 'closed' AND id NOT IN (SELECT position_id FROM position_outcomes)
  `).get().count;

  return { jobs: Object.fromEntries(jobCounts.map(r => [r.status, r.count])), classified, unclassified };
}

// ── Ghost jobs for a specific position ───────────────────────────────

export function getGhostJobsForPosition(positionId) {
  return db.prepare(`
    SELECT * FROM ghost_tracking_jobs WHERE position_id = ? ORDER BY phase, offset_ms
  `).all(positionId);
}

export function areAllPostExitJobsTerminal(positionId) {
  const pending = db.prepare(`
    SELECT COUNT(*) as count FROM ghost_tracking_jobs
    WHERE position_id = ? AND phase = 'post_exit' AND status IN ('pending', 'processing')
  `).get(positionId);
  return pending.count === 0;
}
