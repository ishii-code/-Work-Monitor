import { loadEnv } from '../lib/load-env.js';
loadEnv();

import { getDailySummary, getTodayActivities } from '../lib/db.js';
import { formatDuration, CATEGORY_LABELS } from '../lib/categorizer.js';

function run(): void {
  const date = new Date().toLocaleDateString('sv-SE');
  const summary = getDailySummary(date);
  const activities = getTodayActivities(date);

  console.clear();
  console.log('========================================');
  console.log(`  PC Work Monitor - ${date}`);
  console.log('========================================');
  console.log(`  合計追跡: ${formatDuration(summary.total_tracked_seconds)}`);
  console.log(`  アイドル: ${formatDuration(summary.idle_seconds)}`);
  console.log('');
  console.log('  【カテゴリ別】');

  for (const cat of summary.categories) {
    const pct = summary.total_tracked_seconds > 0
      ? Math.round((cat.total_seconds / summary.total_tracked_seconds) * 100)
      : 0;
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
    console.log(`  ${CATEGORY_LABELS[cat.category].padEnd(20)} ${bar} ${pct}% (${formatDuration(cat.total_seconds)})`);
  }

  console.log('');
  console.log('  【直近の活動 (10件)】');
  const recent = activities.slice(-10).reverse();
  for (const act of recent) {
    const time = new Date(act.start_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const dur = formatDuration(act.duration_seconds);
    const app = act.app_name.padEnd(20);
    console.log(`  ${time} ${app} ${dur.padStart(5)}  [${act.category}]`);
  }

  console.log('========================================');
}

run();
