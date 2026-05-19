import { db } from '../db/connection.js';
import { MIN_CLASSIFIED_FOR_PATTERNS } from '../config.js';
import { now, json, safeJson } from '../utils.js';

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function confidenceFor(sampleSize, effectSize = 0) {
  const support = Math.min(1, sampleSize / Math.max(MIN_CLASSIFIED_FOR_PATTERNS, 1));
  const effect = Math.min(1, Math.abs(effectSize) / 50);
  return Number((support * 0.65 + effect * 0.35).toFixed(3));
}

function bucketMcap(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n < 10_000) return 'under_10k';
  if (n < 25_000) return '10k_25k';
  if (n < 50_000) return '25k_50k';
  if (n < 100_000) return '50k_100k';
  if (n < 250_000) return '100k_250k';
  return 'over_250k';
}

function rowRoute(row) {
  const metrics = safeJson(row.metrics_json, {}) || {};
  if (metrics.route) return metrics.route;
  const snapshot = safeJson(row.snapshot_json, {}) || {};
  return snapshot.candidate?.signals?.route || snapshot.candidate?.signals?.label || 'unknown';
}

function readTags(row, column) {
  const tags = safeJson(row[column], []);
  return Array.isArray(tags) ? tags : [];
}

function rowsForWindow(windowMs) {
  const cutoff = now() - windowMs;
  return db.prepare(`
    SELECT o.*, p.mint, p.symbol, p.pnl_percent, p.exit_reason, p.strategy_id,
           p.entry_mcap, p.opened_at_ms, p.snapshot_json
    FROM position_outcomes o
    JOIN dry_run_positions p ON p.id = o.position_id
    WHERE COALESCE(p.closed_at_ms, o.classified_at_ms) >= ?
      AND COALESCE(p.execution_mode, 'dry_run') = 'dry_run'
  `).all(cutoff);
}

function postExitSnapshots(positionId) {
  return db.prepare(`
    SELECT offset_ms, mcap_vs_exit_pct, price_vs_exit_pct, mcap_vs_entry_pct, price_vs_entry_pct
    FROM ghost_snapshots
    WHERE position_id = ? AND phase = 'post_exit' AND data_quality != 'failed'
    ORDER BY offset_ms ASC
  `).all(positionId);
}

export function simulateCounterfactualExits(positionId) {
  const snapshots = postExitSnapshots(positionId);
  const moves = snapshots.map(row => ({
    offsetMs: row.offset_ms,
    exitPct: row.mcap_vs_exit_pct ?? row.price_vs_exit_pct,
    entryPct: row.mcap_vs_entry_pct ?? row.price_vs_entry_pct,
  })).filter(row => Number.isFinite(Number(row.exitPct)) || Number.isFinite(Number(row.entryPct)));
  const atOrBefore = (ms) => {
    const row = [...moves].reverse().find(item => item.offsetMs <= ms) || moves[0] || null;
    return row ? Number(row.exitPct ?? row.entryPct ?? 0) : null;
  };
  return {
    hold15m: atOrBefore(15 * 60_000),
    hold1h: atOrBefore(60 * 60_000),
    hold3h: atOrBefore(3 * 60 * 60_000),
    hold6h: atOrBefore(6 * 60 * 60_000),
    maxPostExit: moves.length ? Math.max(...moves.map(row => Number(row.exitPct ?? 0))) : null,
    minPostExit: moves.length ? Math.min(...moves.map(row => Number(row.exitPct ?? 0))) : null,
  };
}

function aggregatePattern(patternType, patternKey, rows, windowMs) {
  const pnls = rows.map(row => Number(row.pnl_percent || 0)).filter(Number.isFinite);
  const missed = rows.filter(row => row.primary_outcome === 'EXIT_TOO_EARLY').length;
  const falseSignals = rows.filter(row => row.primary_outcome === 'FALSE_SIGNAL').length;
  const rugs = rows.filter(row => ['RUG_HIT', 'RUG_DODGED'].includes(row.primary_outcome)).length;
  const sims = rows.map(row => simulateCounterfactualExits(row.position_id));
  const hold1hMedian = median(sims.map(item => item.hold1h).filter(value => value != null));
  const hold3hMedian = median(sims.map(item => item.hold3h).filter(value => value != null));
  const actualMedian = median(pnls);
  const effectSize = actualMedian == null ? 0 : actualMedian;
  const confidence = confidenceFor(rows.length, effectSize);
  let recommendation = null;
  if (rows.length >= 3 && actualMedian != null) {
    if (actualMedian < -10 || falseSignals / rows.length >= 0.35) {
      recommendation = `Reduce exposure or tighten screening for ${patternType}=${patternKey}; median PnL is ${actualMedian.toFixed(1)}%.`;
    } else if (actualMedian > 10 && missed / rows.length < 0.3) {
      recommendation = `Keep prioritizing ${patternType}=${patternKey}; median PnL is ${actualMedian.toFixed(1)}%.`;
    } else if (missed / rows.length >= 0.35) {
      recommendation = `Review exit policy for ${patternType}=${patternKey}; missed-upside outcomes are elevated.`;
    }
  }

  return {
    created_at_ms: now(),
    window_ms: windowMs,
    pattern_type: patternType,
    pattern_key: patternKey,
    sample_size: rows.length,
    win_rate: rows.length ? rows.filter(row => Number(row.pnl_percent || 0) > 0).length / rows.length * 100 : null,
    median_pnl_pct: actualMedian,
    missed_upside_rate: rows.length ? missed / rows.length * 100 : null,
    false_signal_rate: rows.length ? falseSignals / rows.length * 100 : null,
    confidence,
    recommendation,
    evidence_json: json({
      rugRate: rows.length ? rugs / rows.length * 100 : null,
      avgEntryScore: rows.reduce((sum, row) => sum + Number(row.entry_score || 0), 0) / Math.max(rows.length, 1),
      avgExitScore: rows.reduce((sum, row) => sum + Number(row.exit_score || 0), 0) / Math.max(rows.length, 1),
      counterfactuals: { hold1hMedian, hold3hMedian },
      outcomes: Object.fromEntries(
        Object.entries(rows.reduce((acc, row) => {
          acc[row.primary_outcome] = (acc[row.primary_outcome] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => b[1] - a[1]),
      ),
    }),
  };
}

function insertPattern(pattern) {
  db.prepare(`
    INSERT INTO learning_patterns (
      created_at_ms, window_ms, pattern_type, pattern_key, sample_size,
      win_rate, median_pnl_pct, missed_upside_rate, false_signal_rate,
      confidence, recommendation, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pattern.created_at_ms,
    pattern.window_ms,
    pattern.pattern_type,
    pattern.pattern_key,
    pattern.sample_size,
    pattern.win_rate,
    pattern.median_pnl_pct,
    pattern.missed_upside_rate,
    pattern.false_signal_rate,
    pattern.confidence,
    pattern.recommendation,
    pattern.evidence_json,
  );
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

export function detectPatterns(windowMs = 72 * 60 * 60_000) {
  const rows = rowsForWindow(windowMs);
  if (rows.length < MIN_CLASSIFIED_FOR_PATTERNS) {
    return { classified: rows.length, inserted: 0, patterns: [], skipped: 'not_enough_classified_data' };
  }

  const candidates = [];
  const groupSpecs = [
    ['route', row => rowRoute(row)],
    ['strategy', row => row.strategy_id || 'unknown'],
    ['strategy_route', row => `${row.strategy_id || 'unknown'}:${rowRoute(row)}`],
    ['entry_mcap_bin', row => bucketMcap(row.entry_mcap)],
    ['hour_utc', row => String(new Date(Number(row.opened_at_ms)).getUTCHours()).padStart(2, '0')],
    ['primary_outcome', row => row.primary_outcome],
    ['entry_tag', row => readTags(row, 'entry_tags_json')[0] || 'none'],
  ];

  for (const [type, keyFn] of groupSpecs) {
    for (const [key, groupRows] of groupBy(rows, keyFn)) {
      if (key === 'unknown' || key === 'none' || groupRows.length < 3) continue;
      candidates.push(aggregatePattern(type, key, groupRows, windowMs));
    }
  }

  const patterns = candidates
    .filter(pattern => pattern.confidence >= 0.35)
    .sort((a, b) => b.confidence - a.confidence || b.sample_size - a.sample_size)
    .slice(0, 20);

  for (const pattern of patterns) insertPattern(pattern);
  return { classified: rows.length, inserted: patterns.length, patterns };
}

export function latestPatterns(limit = 10) {
  return db.prepare(`
    SELECT *
    FROM learning_patterns
    ORDER BY created_at_ms DESC, confidence DESC, sample_size DESC
    LIMIT ?
  `).all(limit);
}
