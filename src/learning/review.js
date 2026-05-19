import { AUTO_REVIEW_MS } from '../config.js';
import { sendTelegram } from '../telegram/send.js';
import { formatWindow, parseWindowMs } from '../utils.js';
import { classifyDuePositions } from './classify.js';
import { detectPatterns } from './patterns.js';
import { summarizeLearningWindow } from './summary.js';
import { generateLessons, storeLearningRun } from './lessons.js';
import { learningReportText } from './report.js';

let reviewRunning = false;

export async function runAutoReview({ windowMs = 72 * 60 * 60_000, sendReport = true } = {}) {
  if (reviewRunning) return { skipped: 'review_already_running' };
  reviewRunning = true;
  try {
    const classification = classifyDuePositions();
    const summary = summarizeLearningWindow(windowMs);
    const patterns = detectPatterns(windowMs);
    const { lessons, raw } = await generateLessons(summary);
    const runId = storeLearningRun(windowMs, summary, lessons, { ...raw, classification, patterns });
    const report = learningReportText(runId, summary, lessons);
    if (sendReport) {
      await sendTelegram(report);
    }
    return { runId, windowMs, classification, patterns, lessonCount: lessons.length, report };
  } finally {
    reviewRunning = false;
  }
}

export async function runManualReview(chatId, bot, windowArg = '72h') {
  const windowMs = parseWindowMs(windowArg);
  await bot.sendMessage(chatId, `Reviewing ghost learning for the last ${formatWindow(windowMs)}...`);
  const result = await runAutoReview({ windowMs, sendReport: false });
  const text = [
    result.skipped ? `Review skipped: ${result.skipped}` : `Review run #${result.runId}`,
    `Classified: ${result.classification?.classified ?? 0}/${result.classification?.checked ?? 0}`,
    `Patterns: ${result.patterns?.inserted ?? 0}`,
    `Lessons: ${result.lessonCount ?? 0}`,
  ].filter(Boolean).join('\n');
  return bot.sendMessage(chatId, text);
}

export function autoReviewIntervalMs() {
  return AUTO_REVIEW_MS;
}
