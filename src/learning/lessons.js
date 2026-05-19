import axios from 'axios';
import {
  ENABLE_LLM, GHOST_AUTO_ACTIVATE_LESSONS, LESSON_EXPIRY_MS, LLM_API_KEY,
  LLM_BASE_URL, LLM_LESSON_MODEL, LLM_TIMEOUT_MS,
} from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';

export function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: bestRoute,
      lesson_type: 'screening',
      confidence: Math.min(0.8, 0.45 + bestRoute.count / 20),
      support_count: bestRoute.count,
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: worstRoute,
      lesson_type: 'screening',
      confidence: Math.min(0.8, 0.45 + worstRoute.count / 20),
      support_count: worstRoute.count,
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
      lesson_type: 'risk',
      confidence: Math.min(0.75, 0.45 + slCount / 10),
      support_count: slCount,
    });
  }
  if (summary.ghost?.classified >= 20 && Number(summary.ghost.missedUpsideRate || 0) >= 35) {
    lessons.push({
      lesson: 'Recent ghost outcomes show confirmed missed upside after exits; treat this as an exit-policy hypothesis, not a buy-screening rule.',
      evidence: summary.ghost,
      lesson_type: 'exit_policy',
      confidence: 0.6,
      support_count: summary.ghost.classified,
    });
  }
  if (summary.ghost?.classified >= 20 && Number(summary.ghost.falseSignalRate || 0) >= 30) {
    lessons.push({
      lesson: 'False-signal ghost outcomes are elevated; require cleaner liquidity, holder, and route evidence before approving similar entries.',
      evidence: summary.ghost,
      lesson_type: 'risk',
      confidence: 0.7,
      support_count: summary.ghost.classified,
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
      lesson_type: 'data_quality',
      confidence: 0.4,
      support_count: summary.positions.closed,
    });
  }
  return lessons.slice(0, 6);
}

export async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_LESSON_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are Charon learning from dry-run trading evidence.',
            'Return strict JSON only.',
            'Do not invent trades or outcomes.',
            'Create compact operational lessons that can improve the next screening prompt.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Analyze this dry-run window and produce up to 6 lessons for future candidate screening.',
            output_schema: {
              lessons: [{
                lesson: 'short actionable rule',
                evidence: 'specific supporting data',
                lesson_type: 'screening|risk|exit_policy|sizing|data_quality',
                confidence: '0.0-1.0',
                support_count: 'integer evidence count',
                strategy_id: 'strategy id or null',
                route: 'route or null',
              }],
            },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => ({
          lesson: String(item.lesson || '').slice(0, 500),
          evidence: item.evidence ?? {},
          lesson_type: ['screening', 'risk', 'exit_policy', 'sizing', 'data_quality'].includes(item.lesson_type) ? item.lesson_type : 'screening',
          confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.5))),
          support_count: Math.max(0, Math.floor(Number(item.support_count ?? 0))),
          strategy_id: item.strategy_id ? String(item.strategy_id).slice(0, 100) : null,
          route: item.route ? String(item.route).slice(0, 100) : null,
        })).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] LLM failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO learning_lessons (
      run_id, created_at_ms, status, lesson, evidence_json, lesson_type,
      confidence, support_count, strategy_id, route, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of lessons) {
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0.5)));
    const supportCount = Math.max(0, Math.floor(Number(item.support_count ?? item.evidence?.count ?? 0)));
    const status = GHOST_AUTO_ACTIVATE_LESSONS && confidence >= 0.7 && supportCount >= 5
      ? 'active'
      : 'candidate';
    insert.run(
      runId,
      now(),
      status,
      item.lesson,
      json(item.evidence || {}),
      item.lesson_type || 'screening',
      confidence,
      supportCount,
      item.strategy_id || null,
      item.route || null,
      now() + LESSON_EXPIRY_MS,
    );
  }
  return runId;
}
