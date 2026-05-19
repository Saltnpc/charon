import { now } from '../utils.js';
import { GHOST_BATCH_SIZE, GHOST_CHECK_MS, GMGN_ENABLED } from '../config.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { fetchGmgnTokenInfo, marketCapFromGmgn, tokenPriceFromGmgn } from '../enrichment/gmgn.js';
import {
  createGhostJobs, claimDueGhostJobs, markJobCompleted, markJobFailed,
  insertGhostSnapshot, PHASES,
} from '../db/ghost.js';
import { db } from '../db/connection.js';

// ── Snapshot Offsets ──────────────────────────────────────────────────
const ENTRY_OFFSETS = [0, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const POST_EXIT_OFFSETS = [
  15 * 60_000,       // +15m
  60 * 60_000,       // +1h
  3 * 3600_000,      // +3h
  6 * 3600_000,      // +6h
  12 * 3600_000,     // +12h
  24 * 3600_000,     // +24h
];

// ── Scheduling ───────────────────────────────────────────────────────

/**
 * Schedule entry tracking snapshots. Call inside createDryRunPosition/createLivePosition.
 */
export function scheduleEntryTracking(positionId, mint) {
  const ts = now();
  createGhostJobs(positionId, mint, PHASES.ENTRY, ts, ENTRY_OFFSETS);
  console.log(`[ghost] entry tracking scheduled for position #${positionId} (${ENTRY_OFFSETS.length} jobs)`);
}

/**
 * Schedule post-exit tracking snapshots. Call on final close (not partial TP).
 */
export function scheduleGhostTracking(positionId, mint) {
  const ts = now();
  createGhostJobs(positionId, mint, PHASES.POST_EXIT, ts, POST_EXIT_OFFSETS);
  console.log(`[ghost] post-exit tracking scheduled for position #${positionId} (${POST_EXIT_OFFSETS.length} jobs)`);
}

// ── Snapshot Fetcher ─────────────────────────────────────────────────

/**
 * Fetch token data from Jupiter (primary) and GMGN (fallback).
 * Returns normalized snapshot data with source_status and data_quality.
 */
async function fetchGhostSnapshot(mint) {
  const jupiterPromise = fetchJupiterAsset(mint, { useCache: false, ttlMs: 0 })
    .catch(err => ({ _error: err.message }));

  const gmgnPromise = GMGN_ENABLED
    ? fetchGmgnTokenInfo(mint, false).catch(err => ({ _error: err.message }))
    : Promise.resolve(null);

  const [jupRaw, gmgnRaw] = await Promise.allSettled([jupiterPromise, gmgnPromise]);
  const jup = jupRaw.status === 'fulfilled' ? jupRaw.value : null;
  const gmgn = gmgnRaw.status === 'fulfilled' ? gmgnRaw.value : null;

  const jupOk = jup && !jup._error && jup.price_info;
  const gmgnOk = gmgn && !gmgn._error && (gmgn.price || gmgn.market_cap);

  // Determine source and quality
  let source, sourceStatus, dataQuality;
  if (jupOk && gmgnOk) {
    source = 'both';
    sourceStatus = 'jupiter_ok_gmgn_ok';
    dataQuality = 'full';
  } else if (jupOk) {
    source = 'jupiter';
    sourceStatus = gmgnOk === false ? 'jupiter_ok_gmgn_disabled' : 'jupiter_ok_gmgn_failed';
    dataQuality = 'partial';
  } else if (gmgnOk) {
    source = 'gmgn';
    sourceStatus = 'jupiter_failed_gmgn_ok';
    dataQuality = 'partial';
  } else {
    source = 'none';
    sourceStatus = 'both_failed';
    dataQuality = 'failed';
  }

  // Normalize values — Jupiter primary, GMGN fallback
  const priceUsd = jupOk
    ? Number(jup.price_info?.price_per_token ?? jup.price_info?.total_price) || null
    : gmgnOk ? tokenPriceFromGmgn(gmgn) : null;

  const mcapUsd = jupOk
    ? Number(jup.market_cap ?? jup.mcap) || null
    : gmgnOk ? marketCapFromGmgn(gmgn) : null;

  const liquidityUsd = jupOk
    ? Number(jup.liquidity) || null
    : gmgnOk ? Number(gmgn.liquidity) || null : null;

  const volumeUsd = gmgnOk
    ? Number(gmgn.volume_24h ?? gmgn.volume) || null
    : null; // Jupiter asset doesn't reliably have volume

  return {
    source,
    source_status: sourceStatus,
    data_quality: dataQuality,
    price_usd: priceUsd,
    mcap_usd: mcapUsd,
    liquidity_usd: liquidityUsd,
    volume_usd: volumeUsd,
    raw_json: JSON.stringify({ jupiter: jupOk ? jup : null, gmgn: gmgnOk ? gmgn : null }),
  };
}

// ── Position Data Lookup ─────────────────────────────────────────────

function getPositionPrices(positionId) {
  const row = db.prepare(`
    SELECT entry_price, exit_price, entry_mcap, exit_mcap
    FROM dry_run_positions WHERE id = ?
  `).get(positionId);
  return row || {};
}

function pctChange(current, reference) {
  if (!current || !reference || reference === 0) return null;
  return ((current - reference) / reference) * 100;
}

// ── Reentrancy Guard ─────────────────────────────────────────────────
let ghostMonitorRunning = false;

/**
 * Main ghost tracking monitor loop.
 * Called every GHOST_CHECK_MS from app.js setInterval.
 * Atomic job claiming prevents overlap even across restarts.
 */
export async function monitorGhostTracking() {
  if (ghostMonitorRunning) return;
  ghostMonitorRunning = true;

  try {
    const jobs = claimDueGhostJobs(GHOST_BATCH_SIZE);
    if (jobs.length === 0) return;

    console.log(`[ghost] processing ${jobs.length} snapshot job(s)`);

    for (const job of jobs) {
      try {
        const snapshot = await fetchGhostSnapshot(job.mint);

        if (snapshot.data_quality === 'failed') {
          markJobFailed(job.id, `All sources failed: ${snapshot.source_status}`);
          continue;
        }

        // Compute relative percentages
        const prices = getPositionPrices(job.position_id);

        insertGhostSnapshot({
          position_id: job.position_id,
          mint: job.mint,
          phase: job.phase,
          offset_ms: job.offset_ms,
          requested_for_ms: job.due_at_ms,
          observed_at_ms: now(),
          source: snapshot.source,
          source_status: snapshot.source_status,
          data_quality: snapshot.data_quality,
          price_usd: snapshot.price_usd,
          mcap_usd: snapshot.mcap_usd,
          liquidity_usd: snapshot.liquidity_usd,
          volume_usd: snapshot.volume_usd,
          price_vs_entry_pct: pctChange(snapshot.price_usd, prices.entry_price),
          price_vs_exit_pct: pctChange(snapshot.price_usd, prices.exit_price),
          mcap_vs_entry_pct: pctChange(snapshot.mcap_usd, prices.entry_mcap),
          mcap_vs_exit_pct: pctChange(snapshot.mcap_usd, prices.exit_mcap),
          raw_json: snapshot.raw_json,
        });

        markJobCompleted(job.id);
      } catch (err) {
        console.log(`[ghost] job #${job.id} error: ${err.message}`);
        markJobFailed(job.id, err.message);
      }
    }
  } catch (err) {
    console.log(`[ghost] monitor error: ${err.message}`);
  } finally {
    ghostMonitorRunning = false;
  }
}
