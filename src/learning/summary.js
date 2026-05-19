import { db } from '../db/connection.js';
import { now, safeJson, parseWindowMs, formatWindow } from '../utils.js';

export function positionSnapshotCandidate(position) {
  return safeJson(position.snapshot_json, {})?.candidate || {};
}

export function summarizeLearningWindow(windowMs) {
  const cutoff = now() - windowMs;
  const positions = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE opened_at_ms >= ?
      AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
    ORDER BY opened_at_ms ASC
  `).all(cutoff);
  const closed = positions.filter(position => position.status === 'closed');
  const winners = closed.filter(position => Number(position.pnl_percent || 0) > 0);
  const losers = closed.filter(position => Number(position.pnl_percent || 0) < 0);
  const totalPnlPercent = closed.reduce((sum, position) => sum + Number(position.pnl_percent || 0), 0);
  const totalPnlSol = closed.reduce((sum, position) => sum + Number(position.pnl_sol || 0), 0);
  const byRoute = new Map();
  const byStrategy = new Map();
  for (const position of closed) {
    const candidate = positionSnapshotCandidate(position);
    const route = candidate.signals?.route || candidate.signals?.label || 'unknown';
    const row = byRoute.get(route) || { route, count: 0, wins: 0, losses: 0, pnlPercent: 0, pnlSol: 0 };
    row.count += 1;
    row.wins += Number(position.pnl_percent || 0) > 0 ? 1 : 0;
    row.losses += Number(position.pnl_percent || 0) < 0 ? 1 : 0;
    row.pnlPercent += Number(position.pnl_percent || 0);
    row.pnlSol += Number(position.pnl_sol || 0);
    byRoute.set(route, row);

    const strategy = position.strategy_id || candidate.signals?.strategy || safeJson(position.snapshot_json, {})?.strategy || 'unknown';
    const stratRow = byStrategy.get(strategy) || { strategy, count: 0, wins: 0, losses: 0, pnlPercent: 0, pnlSol: 0 };
    stratRow.count += 1;
    stratRow.wins += Number(position.pnl_percent || 0) > 0 ? 1 : 0;
    stratRow.losses += Number(position.pnl_percent || 0) < 0 ? 1 : 0;
    stratRow.pnlPercent += Number(position.pnl_percent || 0);
    stratRow.pnlSol += Number(position.pnl_sol || 0);
    byStrategy.set(strategy, stratRow);
  }
  const batches = db.prepare(`
    SELECT verdict, COUNT(*) AS count, AVG(confidence) AS avg_confidence
    FROM llm_batches
    WHERE created_at_ms >= ?
    GROUP BY verdict
  `).all(cutoff);
  const actions = db.prepare(`
    SELECT action, COUNT(*) AS count
    FROM decision_logs
    WHERE at_ms >= ?
    GROUP BY action
    ORDER BY count DESC
  `).all(cutoff);
  const best = [...closed].sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0)).slice(0, 5).map(position => ({
    mint: position.mint,
    symbol: position.symbol,
    pnlPercent: Number(position.pnl_percent || 0),
    exitReason: position.exit_reason,
    entryMcap: position.entry_mcap,
    exitMcap: position.exit_mcap,
    route: positionSnapshotCandidate(position).signals?.route || 'unknown',
  }));
  const worst = [...closed].sort((a, b) => Number(a.pnl_percent || 0) - Number(b.pnl_percent || 0)).slice(0, 5).map(position => ({
    mint: position.mint,
    symbol: position.symbol,
    pnlPercent: Number(position.pnl_percent || 0),
    exitReason: position.exit_reason,
    entryMcap: position.entry_mcap,
    exitMcap: position.exit_mcap,
    route: positionSnapshotCandidate(position).signals?.route || 'unknown',
  }));
  const outcomes = db.prepare(`
    SELECT o.*, p.mint, p.symbol, p.pnl_percent, p.exit_reason, p.strategy_id, p.opened_at_ms
    FROM position_outcomes o
    JOIN dry_run_positions p ON p.id = o.position_id
    WHERE COALESCE(p.closed_at_ms, p.opened_at_ms) >= ?
      AND COALESCE(p.execution_mode, 'dry_run') = 'dry_run'
    ORDER BY o.classified_at_ms DESC
  `).all(cutoff);
  const pendingGhost = db.prepare(`
    SELECT COUNT(*) AS count
    FROM dry_run_positions p
    LEFT JOIN position_outcomes o ON o.position_id = p.id
    WHERE p.status = 'closed'
      AND COALESCE(p.closed_at_ms, p.opened_at_ms) >= ?
      AND COALESCE(p.execution_mode, 'dry_run') = 'dry_run'
      AND o.position_id IS NULL
  `).get(cutoff).count;
  const byPrimaryOutcome = outcomes.reduce((acc, row) => {
    acc[row.primary_outcome] = (acc[row.primary_outcome] || 0) + 1;
    return acc;
  }, {});
  const avg = (rows, key) => rows.length
    ? rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length
    : null;
  const tagCount = (column, tag) => outcomes.filter(row => {
    const tags = safeJson(row[column], []);
    return Array.isArray(tags) && tags.includes(tag);
  }).length;
  return {
    windowMs,
    fromMs: cutoff,
    toMs: now(),
    positions: {
      opened: positions.length,
      closed: closed.length,
      open: positions.length - closed.length,
      wins: winners.length,
      losses: losers.length,
      winRate: closed.length ? winners.length / closed.length * 100 : null,
      totalPnlPercent,
      avgPnlPercent: closed.length ? totalPnlPercent / closed.length : null,
      totalPnlSol,
      byRoute: [...byRoute.values()].map(row => ({
        ...row,
        winRate: row.count ? row.wins / row.count * 100 : null,
        avgPnlPercent: row.count ? row.pnlPercent / row.count : null,
      })).sort((a, b) => b.pnlPercent - a.pnlPercent),
      byStrategy: [...byStrategy.values()].map(row => ({
        ...row,
        winRate: row.count ? row.wins / row.count * 100 : null,
        avgPnlPercent: row.count ? row.pnlPercent / row.count : null,
      })).sort((a, b) => b.pnlPercent - a.pnlPercent),
      best,
      worst,
    },
    llm: { batches, actions },
    ghost: {
      classified: outcomes.length,
      pending: pendingGhost,
      byPrimaryOutcome,
      avgEntryScore: avg(outcomes, 'entry_score'),
      avgExitScore: avg(outcomes, 'exit_score'),
      missedUpsideRate: outcomes.length ? outcomes.filter(row => row.primary_outcome === 'EXIT_TOO_EARLY').length / outcomes.length * 100 : null,
      rugDodgedRate: outcomes.length ? outcomes.filter(row => row.primary_outcome === 'RUG_DODGED').length / outcomes.length * 100 : null,
      falseSignalRate: outcomes.length ? outcomes.filter(row => row.primary_outcome === 'FALSE_SIGNAL').length / outcomes.length * 100 : null,
      lateEntryRate: outcomes.length ? tagCount('entry_tags_json', 'ENTRY_NEAR_RANGE_HIGH') / outcomes.length * 100 : null,
      bestExitQuality: [...outcomes].sort((a, b) => Number(b.exit_score || 0) - Number(a.exit_score || 0)).slice(0, 3),
      worstExitQuality: [...outcomes].sort((a, b) => Number(a.exit_score || 0) - Number(b.exit_score || 0)).slice(0, 3),
    },
  };
}
