import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting, allActiveStrategies } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, updateCandidateSnapshot, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  if (tradingMode() === 'dry_run') {
    await processDryRunCandidateFromSignals(signals);
    return;
  }

  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const strat = activeStrategy();
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= numSetting('llm_min_confidence', 75)) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence', 75),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

function candidateForStrategy(candidate, strat, filters = null) {
  return {
    ...candidate,
    filters: filters || filterCandidate(candidate, strat),
    signals: {
      ...candidate.signals,
      strategy: strat.id,
    },
  };
}

function ruleDecisionForStrategy(candidateId, candidate, strat, reason) {
  return {
    verdict: 'BUY',
    confidence: 100,
    selected_candidate_id: candidateId,
    selected_mint: candidate.token.mint,
    selected_row: { id: candidateId, candidate },
    reason,
    risks: [],
    suggested_tp_percent: strat.tp_stages?.[0]?.trigger_percent ?? strat.tp_percent ?? numSetting('default_tp_percent', 50),
    suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
    raw: null,
  };
}

async function shadowDecisionForStrategy(candidateId, candidate, strat) {
  if (!strat.use_llm) {
    return { batchId: null, rows: [], decision: ruleDecisionForStrategy(candidateId, candidate, strat, `Strategy '${strat.id}' is rule-based; dry-run entry recorded.`) };
  }
  const rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10))
    .map(row => row.id === candidateId ? { ...row, candidate } : row);
  if (!rows.some(row => row.id === candidateId)) rows.push({ id: candidateId, candidate });
  const decision = await decideCandidateBatch(rows, candidateId);
  const batchId = storeBatchDecision(candidateId, rows, decision);
  const selectedThisCandidate = decision.selected_row?.id === candidateId;
  return {
    batchId,
    rows,
    decision: {
      ...decision,
      shadow_mode: true,
      shadow_selected_this_candidate: selectedThisCandidate,
      reason: `[shadow] ${decision.reason || 'LLM screening recorded; dry-run strategy entry is rules-based.'}`,
      suggested_tp_percent: strat.tp_stages?.[0]?.trigger_percent ?? decision.suggested_tp_percent ?? strat.tp_percent,
      suggested_sl_percent: decision.suggested_sl_percent ?? strat.sl_percent,
    },
  };
}

async function processDryRunCandidateFromSignals(signals) {
  const strategies = allActiveStrategies();
  if (!strategies.some(strat => canOpenMorePositions(strat))) {
    console.log(`[agent] all dry-run strategy capacities reached, skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const strategyFilters = {};
  for (const strat of strategies) {
    strategyFilters[strat.id] = filterCandidate(candidate, strat);
  }
  const passedStrategies = strategies.filter(strat => strategyFilters[strat.id]?.passed);
  candidate.strategyFilters = strategyFilters;
  candidate.filters = {
    passed: passedStrategies.length > 0,
    failures: passedStrategies.length ? [] : Object.entries(strategyFilters).map(([id, result]) => `${id}: ${(result.failures || []).join('; ') || 'failed'}`),
    warnings: [...new Set(Object.values(strategyFilters).flatMap(result => result.warnings || []))],
    strategy: 'multi',
  };

  const candidateId = upsertCandidate(candidate, signature);
  updateCandidateSnapshot(candidateId, candidate, candidate.filters.passed ? 'candidate' : 'filtered');

  for (const strat of strategies) {
    const strategyCandidate = candidateForStrategy(candidate, strat, strategyFilters[strat.id]);
    const strategyRow = { id: candidateId, candidate: strategyCandidate };

    if (!strategyCandidate.filters.passed) {
      console.log(`[candidate] ${strat.id} filtered ${candidate.token.mint.slice(0, 8)}... ${strategyCandidate.filters.failures.join('; ')}`);
      logDecisionEvent({
        triggerCandidateId: candidateId,
        selectedRow: strategyRow,
        rows: [strategyRow],
        decision: { verdict: 'REJECT', confidence: 100, reason: strategyCandidate.filters.failures.join('; ') },
        mode: 'dry_run',
        action: 'strategy_filter_rejected',
        guardrails: { strategy_id: strat.id, failures: strategyCandidate.filters.failures, warnings: strategyCandidate.filters.warnings || [] },
      });
      continue;
    }

    if (!canOpenMorePositions(strat)) {
      logDecisionEvent({
        triggerCandidateId: candidateId,
        selectedRow: strategyRow,
        rows: [strategyRow],
        decision: { verdict: 'WATCH', confidence: 100, reason: `Strategy '${strat.id}' capacity reached.` },
        mode: 'dry_run',
        action: 'entry_skipped_max_positions',
        guardrails: { strategy_id: strat.id, maxOpenPositions: strat.max_open_positions, openPositions: openPositionCount(strat) },
      });
      continue;
    }

    const { batchId, rows, decision } = await shadowDecisionForStrategy(candidateId, strategyCandidate, strat);
    const decisionId = storeDecision(candidateId, strategyCandidate, decision);
    decision.id = decisionId;
    const positionId = await createDryRunPosition(candidateId, strategyCandidate, decision, `strategy_${strat.id}_dry_run`, strat);
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow: strategyRow,
      rows: rows.length ? rows : [strategyRow],
      decision,
      mode: 'dry_run',
      action: 'dry_run_strategy_entry',
      guardrails: { strategy_id: strat.id, maxOpenPositions: strat.max_open_positions, openPositions: openPositionCount(strat), llmShadowMode: Boolean(strat.use_llm) },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const strat = activeStrategy();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow, strat);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`, strat);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
