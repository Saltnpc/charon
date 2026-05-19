import { getPositionsReadyForClassification, getSnapshotsForPosition, insertPositionOutcome, PHASES } from '../db/ghost.js';
import { now, json, safeJson } from '../utils.js';

const PRIMARY_PRECEDENCE = [
  'RUG_HIT',
  'RUG_DODGED',
  'FALSE_SIGNAL',
  'EXIT_TOO_LATE',
  'EXIT_TOO_EARLY',
  'PROTECTED_PROFIT',
  'LOSS_CONTAINED',
  'SIDEWAYS',
  'NEUTRAL',
];

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function pctChange(current, reference) {
  const currentNumber = Number(current);
  const referenceNumber = Number(reference);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(referenceNumber) || referenceNumber <= 0) return null;
  return ((currentNumber / referenceNumber) - 1) * 100;
}

function validSnapshots(rows) {
  return rows.filter(row => row.data_quality !== 'failed' && (row.price_usd || row.mcap_usd));
}

function metricPct(row, basis) {
  if (basis === 'exit') return row.mcap_vs_exit_pct ?? row.price_vs_exit_pct;
  return row.mcap_vs_entry_pct ?? row.price_vs_entry_pct;
}

function parsePositionContext(position) {
  const snapshot = safeJson(position.snapshot_json, {}) || {};
  const candidate = snapshot.candidate || {};
  const decision = snapshot.decision || {};
  return { snapshot, candidate, decision };
}

function routeFor(candidate) {
  return candidate.signals?.route || candidate.signals?.label || candidate.filters?.strategy || 'unknown';
}

function rangeHighDistance(candidate) {
  const chart = candidate.chart || {};
  const direct = chart.distanceFromAthPercent ?? chart.belowRangeHighPercent;
  if (Number.isFinite(Number(direct))) return Number(direct);
  const window = chart.windows?.find(item => item.label === 'ath_context_24h_5m' && item.available)
    || chart.windows?.find(item => item.available);
  return Number.isFinite(Number(window?.belowHighPercent)) ? Number(window.belowHighPercent) : null;
}

function addTag(tags, tag, when = true) {
  if (when && !tags.includes(tag)) tags.push(tag);
}

function scoreEntry(position, entrySnapshots, candidate, decision) {
  const tags = [];
  const metrics = candidate.metrics || {};
  const distanceFromHigh = rangeHighDistance(candidate);
  const liquidity = Number(metrics.liquidityUsd || 0);
  const holderCount = Number(metrics.holderCount || 0);
  const top20 = Number(metrics.top20HolderPercent || metrics.top20_holder_percent || 0);
  const sourceCount = Number(candidate.signals?.sourceCount || candidate.signals?.sources?.length || 0);
  const confidence = Number(decision.confidence || 0);
  const earlyPath = validSnapshots(entrySnapshots).map(row => metricPct(row, 'entry')).filter(Number.isFinite);
  const maxEarly = earlyPath.length ? Math.max(...earlyPath) : null;
  const minEarly = earlyPath.length ? Math.min(...earlyPath) : null;

  addTag(tags, 'ENTRY_NEAR_RANGE_HIGH', distanceFromHigh != null && distanceFromHigh >= -15);
  addTag(tags, 'LOW_LIQUIDITY', liquidity > 0 && liquidity < 10_000);
  addTag(tags, 'WEAK_HOLDER_BASE', holderCount > 0 && holderCount < 100);
  addTag(tags, 'OVERCROWDED_HOLDERS', top20 > 70);
  addTag(tags, 'WEAK_EARLY_CONFIRMATION', minEarly != null && minEarly <= -20 && (maxEarly == null || maxEarly < 20));

  const timingScore = distanceFromHigh == null ? 16 : distanceFromHigh >= -5 ? 6 : distanceFromHigh >= -15 ? 12 : distanceFromHigh >= -40 ? 22 : 18;
  const liquidityScore = liquidity <= 0 ? 10 : liquidity >= 50_000 ? 20 : liquidity >= 15_000 ? 15 : 8;
  const holderScore = holderCount <= 0 ? 10 : holderCount >= 1000 ? 20 : holderCount >= 250 ? 15 : 8;
  const signalScore = clamp((sourceCount * 5) + (confidence / 100 * 10), 5, 20);
  const earlyScore = maxEarly == null ? 8 : maxEarly >= 40 ? 15 : minEarly <= -30 ? 4 : maxEarly >= 10 ? 12 : 8;

  return {
    score: clamp(timingScore + liquidityScore + holderScore + signalScore + earlyScore),
    tags,
    metrics: {
      route: routeFor(candidate),
      distanceFromHigh,
      liquidity,
      holderCount,
      top20,
      sourceCount,
      confidence,
      maxEarly,
      minEarly,
    },
  };
}

function scoreExit(position, postExitSnapshots) {
  const tags = [];
  const riskTags = [];
  const signalTags = [];
  const valid = validSnapshots(postExitSnapshots);
  const exitMoves = valid.map(row => metricPct(row, 'exit')).filter(Number.isFinite);
  const entryMoves = valid.map(row => metricPct(row, 'entry')).filter(Number.isFinite);
  const maxAfterExitPct = exitMoves.length ? Math.max(...exitMoves) : null;
  const minAfterExitPct = exitMoves.length ? Math.min(...exitMoves) : null;
  const prices = valid.map(row => Number(row.price_usd)).filter(Number.isFinite);
  const maxPriceAfterExit = prices.length ? Math.max(...prices) : null;
  const minPriceAfterExit = prices.length ? Math.min(...prices) : null;
  const maxAfterEntryPct = entryMoves.length ? Math.max(...entryMoves) : null;
  const minAfterEntryPct = entryMoves.length ? Math.min(...entryMoves) : null;
  const missedUpsidePct = maxAfterExitPct != null ? Math.max(0, maxAfterExitPct) : null;
  const avoidedDownsidePct = minAfterExitPct != null ? Math.max(0, -minAfterExitPct) : null;
  const pnl = Number(position.pnl_percent || 0);
  const highWaterPct = pctChange(position.high_water_mcap, position.entry_mcap) ?? pctChange(position.high_water_price, position.entry_price);
  const tp = Number(position.tp_percent || 0);
  const exitReason = String(position.exit_reason || '').toUpperCase();
  const sustainedUpside = exitMoves.filter(value => value >= 50).length >= 2 || (missedUpsidePct ?? 0) >= 100;

  addTag(tags, 'EXIT_TOO_EARLY', sustainedUpside && (avoidedDownsidePct ?? 0) < 50);
  addTag(tags, 'EXIT_TOO_LATE', exitReason === 'SL' && highWaterPct != null && highWaterPct >= Math.max(tp, 25));
  addTag(tags, 'PROTECTED_PROFIT', pnl > 0 && ['TP', 'TRAILING_TP', 'MANUAL'].includes(exitReason) && (avoidedDownsidePct ?? 0) >= 20);
  addTag(tags, 'LOSS_CONTAINED', exitReason === 'SL' && (avoidedDownsidePct ?? 0) >= 20);
  addTag(tags, 'SIDEWAYS', ['MAX_HOLD', 'MANUAL'].includes(exitReason) && Math.abs(pnl) < 10 && (missedUpsidePct ?? 0) < 30 && (avoidedDownsidePct ?? 0) < 30);

  addTag(riskTags, 'RUG_HIT', pnl <= -50 || (exitReason === 'SL' && (minAfterEntryPct ?? 0) <= -80));
  addTag(riskTags, 'RUG_DODGED', pnl >= 0 && (avoidedDownsidePct ?? 0) >= 60);
  addTag(riskTags, 'LIQUIDITY_CRASH', valid.some(row => Number(row.liquidity_usd || 0) > 0 && Number(row.liquidity_usd) < 5_000));
  addTag(signalTags, 'FALSE_SIGNAL', pnl <= -20 && (missedUpsidePct ?? 0) < 25);
  addTag(signalTags, 'GOOD_SIGNAL_BAD_EXIT', sustainedUpside);
  addTag(signalTags, 'GOOD_ENTRY_BAD_HOLD_RULE', tags.includes('EXIT_TOO_LATE'));

  const capturedUpsideScore = missedUpsidePct == null ? 15 : missedUpsidePct >= 100 ? 4 : missedUpsidePct >= 50 ? 12 : 25;
  const drawdownScore = avoidedDownsidePct == null ? 12 : avoidedDownsidePct >= 60 ? 25 : avoidedDownsidePct >= 20 ? 20 : 12;
  const rulesScore = exitReason === 'MANUAL' ? 10 : tags.includes('EXIT_TOO_LATE') ? 6 : tags.includes('EXIT_TOO_EARLY') ? 8 : 18;
  const validationScore = riskTags.includes('RUG_DODGED') || tags.includes('PROTECTED_PROFIT') ? 15 : tags.includes('LOSS_CONTAINED') ? 12 : 8;
  const qualityPenalty = valid.length >= 3 ? 0 : -10;

  return {
    score: clamp(capturedUpsideScore + drawdownScore + rulesScore + validationScore + qualityPenalty),
    tags,
    riskTags,
    signalTags,
    metrics: {
      maxAfterExitPct,
      minAfterExitPct,
      maxAfterEntryPct,
      minAfterEntryPct,
      missedUpsidePct,
      avoidedDownsidePct,
      highWaterPct,
      exitReason,
      sustainedUpside,
      maxPriceAfterExit,
      minPriceAfterExit,
    },
  };
}

function selectPrimary({ exitTags, riskTags, signalTags }) {
  const all = new Set([...exitTags, ...riskTags, ...signalTags]);
  return PRIMARY_PRECEDENCE.find(label => label === 'NEUTRAL' || all.has(label)) || 'NEUTRAL';
}

export function classifyPosition(position) {
  const snapshots = getSnapshotsForPosition(position.id);
  const entrySnapshots = snapshots.filter(row => row.phase === PHASES.ENTRY);
  const postExitSnapshots = snapshots.filter(row => row.phase === PHASES.POST_EXIT);
  const { candidate, decision } = parsePositionContext(position);
  const entry = scoreEntry(position, entrySnapshots, candidate, decision);
  const exit = scoreExit(position, postExitSnapshots);
  const dataQuality = validSnapshots(postExitSnapshots).length >= 3 && validSnapshots(entrySnapshots).length >= 2 ? 'full' : 'weak';
  const primary = selectPrimary({ exitTags: exit.tags, riskTags: exit.riskTags, signalTags: exit.signalTags });
  const totalScore = clamp((entry.score * 0.4) + (exit.score * 0.6));
  const metrics = {
    ...entry.metrics,
    ...exit.metrics,
    pnlPercent: Number(position.pnl_percent || 0),
    strategyId: position.strategy_id || null,
  };

  return {
    position_id: position.id,
    classified_at_ms: now(),
    primary_outcome: primary,
    entry_score: entry.score,
    exit_score: exit.score,
    total_score: totalScore,
    entry_tags_json: json(entry.tags),
    exit_tags_json: json(exit.tags),
    risk_tags_json: json(exit.riskTags),
    signal_tags_json: json(exit.signalTags),
    max_price_after_exit: exit.metrics.maxPriceAfterExit,
    min_price_after_exit: exit.metrics.minPriceAfterExit,
    missed_upside_pct: exit.metrics.missedUpsidePct,
    avoided_downside_pct: exit.metrics.avoidedDownsidePct,
    data_quality: dataQuality,
    snapshot_count: snapshots.length,
    review_status: 'auto_classified',
    metrics_json: json(metrics),
    evidence_json: json({
      entryOffsets: entrySnapshots.map(row => ({ offsetMs: row.offset_ms, quality: row.data_quality, movePct: metricPct(row, 'entry') })),
      postExitOffsets: postExitSnapshots.map(row => ({ offsetMs: row.offset_ms, quality: row.data_quality, movePct: metricPct(row, 'exit') })),
    }),
  };
}

export function classifyDuePositions() {
  const positions = getPositionsReadyForClassification();
  let classified = 0;
  const errors = [];
  for (const position of positions) {
    try {
      insertPositionOutcome(classifyPosition(position));
      classified += 1;
    } catch (err) {
      errors.push({ positionId: position.id, error: err.message });
      console.log(`[classify] position #${position.id} failed: ${err.message}`);
    }
  }
  return { checked: positions.length, classified, errors };
}
