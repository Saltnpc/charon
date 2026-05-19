import { escapeHtml, fmtPct, fmtSol } from '../format.js';
import { formatWindow } from '../utils.js';

export function learningReportText(runId, summary, lessons) {
  const ghostOutcomes = summary.ghost?.byPrimaryOutcome
    ? Object.entries(summary.ghost.byPrimaryOutcome)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, count]) => `${escapeHtml(key)} ${count}`)
        .join(', ')
    : '';
  const strategyLines = (summary.positions.byStrategy || [])
    .slice(0, 4)
    .map(row => `${escapeHtml(row.strategy)}: ${fmtPct(row.avgPnlPercent)} avg, ${fmtPct(row.winRate)} WR (${row.count})`);

  return [
    '<b>Charon Learning</b>',
    '',
    `Run: <b>#${runId}</b> | Window: <b>${formatWindow(summary.windowMs)}</b>`,
    `Closed: ${summary.positions.closed}/${summary.positions.opened} | Win rate: ${fmtPct(summary.positions.winRate)}`,
    `Avg PnL: ${fmtPct(summary.positions.avgPnlPercent)} | Total: ${fmtSol(summary.positions.totalPnlSol)} SOL`,
    summary.positions.byRoute?.length ? `Best route: <b>${escapeHtml(summary.positions.byRoute[0].route)}</b> avg ${fmtPct(summary.positions.byRoute[0].avgPnlPercent)} (${summary.positions.byRoute[0].count})` : null,
    strategyLines.length ? '' : null,
    strategyLines.length ? '<b>Strategy Comparison</b>' : null,
    ...strategyLines,
    summary.ghost ? '' : null,
    summary.ghost ? '<b>Ghost Outcomes</b>' : null,
    summary.ghost ? `Classified: ${summary.ghost.classified} | Pending: ${summary.ghost.pending}` : null,
    summary.ghost ? `Avg entry/exit score: ${fmtPct(summary.ghost.avgEntryScore)} / ${fmtPct(summary.ghost.avgExitScore)}` : null,
    ghostOutcomes ? `Outcomes: ${ghostOutcomes}` : null,
    summary.ghost ? `Missed upside: ${fmtPct(summary.ghost.missedUpsideRate)} | False signal: ${fmtPct(summary.ghost.falseSignalRate)}` : null,
    '',
    '<b>Lessons</b>',
    ...lessons.map((item, index) => `${index + 1}. ${escapeHtml(item.lesson)}`),
  ].filter(Boolean).join('\n');
}
