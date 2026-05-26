import { loadEnv } from '../lib/load-env.js';
loadEnv();

import { getDailySummary, saveInsight } from '../lib/db.js';
import { analyzeDay, formatInsightForSlack } from '../lib/analyzer.js';
import { sendToSlack, logToConsole } from '../lib/notifier.js';
import { formatDuration, CATEGORY_LABELS } from '../lib/categorizer.js';

async function run(): Promise<void> {
  const date = process.argv[2] ?? new Date().toLocaleDateString('sv-SE');
  logToConsole(`Generating daily report for ${date}...`);

  const summary = getDailySummary(date);

  if (summary.total_tracked_seconds < 60) {
    logToConsole('Not enough tracking data for this date.');
    return;
  }

  console.log('\n--- 作業サマリー ---');
  console.log(`日付: ${summary.date}`);
  console.log(`合計追跡: ${formatDuration(summary.total_tracked_seconds)}`);
  console.log(`アイドル: ${formatDuration(summary.idle_seconds)}`);
  console.log('');

  for (const cat of summary.categories) {
    const pct = Math.round((cat.total_seconds / summary.total_tracked_seconds) * 100);
    console.log(`${CATEGORY_LABELS[cat.category]}: ${formatDuration(cat.total_seconds)} (${pct}%)`);
  }

  console.log('\n--- Claude AI 分析中... ---');
  const insight = await analyzeDay(summary);
  saveInsight(insight);

  console.log('\n--- AI インサイト ---');
  console.log(`効率スコア: ${insight.efficiency_score}/100`);
  console.log(`評価: ${insight.summary}`);

  if (insight.suggestions.length > 0) {
    console.log('\n--- 自動化提案 ---');
    for (const s of insight.suggestions) {
      console.log(`[${s.priority.toUpperCase()}] ${s.task_description} (${s.time_spent_minutes}分)`);
      console.log(`  → ${s.agent_name}: ${s.estimated_savings_minutes}分削減可能`);
    }
  }

  if (insight.action_items.length > 0) {
    console.log('\n--- 明日のアクション ---');
    insight.action_items.forEach((item, i) => console.log(`${i + 1}. ${item}`));
  }

  const slackMessage = formatInsightForSlack(insight, summary);
  console.log('\n--- Slack 送信 ---');
  await sendToSlack(slackMessage);
  logToConsole('Done!');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
