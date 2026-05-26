import { loadEnv } from '../lib/load-env.js';
loadEnv();

import cron from 'node-cron';
import { getActiveWindow, checkAccessibilityPermission } from '../lib/monitor.js';
import { applyPrivacyFilter } from '../lib/privacy.js';
import { categorize } from '../lib/categorizer.js';
import { upsertActivity, updateActivityEnd, getDailySummary } from '../lib/db.js';
import { analyzeDay } from '../lib/analyzer.js';
import { formatInsightForSlack } from '../lib/analyzer.js';
import { sendToSlack, logToConsole } from '../lib/notifier.js';
import { saveInsight } from '../lib/db.js';
import { startCloudSync } from '../lib/cloud-sync.js';
import type { ActivityRecord } from '../lib/types.js';

const POLL_INTERVAL_MS = 10_000; // 10秒ごと
const CHANGE_THRESHOLD_SECONDS = 5; // 5秒以上同じ画面で記録

interface CurrentActivity {
  id: number;
  appName: string;
  windowTitle: string;
  url: string;
  startTime: Date;
}

let current: CurrentActivity | null = null;

function today(): string {
  return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
}

function isSameActivity(a: CurrentActivity, appName: string, windowTitle: string): boolean {
  return a.appName === appName && a.windowTitle === windowTitle;
}

async function poll(): Promise<void> {
  const win = await getActiveWindow();
  const now = new Date();
  const filtered = win.isIdle
    ? { appName: win.appName, windowTitle: '', url: '', isPrivate: false }
    : applyPrivacyFilter(win.appName, win.windowTitle, win.url);
  const category = win.isIdle ? 'idle' : categorize(filtered.appName, filtered.windowTitle, filtered.url);

  if (current) {
    const durationSeconds = Math.round((now.getTime() - current.startTime.getTime()) / 1000);

    if (!isSameActivity(current, win.appName, win.windowTitle)) {
      // アクティビティ変更 → 前のレコードを閉じる
      if (durationSeconds >= CHANGE_THRESHOLD_SECONDS) {
        updateActivityEnd(current.id, now.toISOString(), durationSeconds);
      }
      current = null;
    } else {
      // 同じアクティビティ継続 → duration更新のみ（DB は10秒ごとに更新）
      updateActivityEnd(current.id, now.toISOString(), durationSeconds);
      return;
    }
  }

  // 新しいアクティビティを開始
  const record: Omit<ActivityRecord, 'id'> = {
    app_name: filtered.appName,
    window_title: filtered.windowTitle,
    url: filtered.url,
    category,
    start_time: now.toISOString(),
    end_time: null,
    duration_seconds: 0,
    date: today(),
  };

  const id = upsertActivity(record);
  current = {
    id,
    appName: filtered.appName,
    windowTitle: filtered.windowTitle,
    url: filtered.url,
    startTime: now,
  };

  const label = win.isIdle ? '😴 idle' : `${filtered.appName}${filtered.windowTitle && filtered.windowTitle !== '[非表示]' ? ` - ${filtered.windowTitle.slice(0, 50)}` : ''}`;
  logToConsole(`[${category}] ${label}`);
}

// メインポーリングループ
// 起動時に権限確認
const hasPermission = await checkAccessibilityPermission();
if (!hasPermission) {
  console.log('\n⚠️  アクセシビリティ権限が必要です。');
  console.log('   システム設定 > プライバシーとセキュリティ > アクセシビリティ');
  console.log('   で Terminal（またはこのアプリ）を許可してください。\n');
}

logToConsole('🚀 pc-work-monitor daemon started');

startCloudSync();

setInterval(() => {
  poll().catch(e => console.error('[poll error]', e));
}, POLL_INTERVAL_MS);

// 即時実行
poll().catch(e => console.error('[poll error]', e));

// 毎日22:00 に日報生成
cron.schedule('0 22 * * *', async () => {
  logToConsole('📊 Generating daily report...');
  try {
    const summary = getDailySummary(today());
    if (summary.total_tracked_seconds < 60) {
      logToConsole('Not enough data for report');
      return;
    }
    const insight = await analyzeDay(summary);
    saveInsight(insight);
    const message = formatInsightForSlack(insight, summary);
    await sendToSlack(message);
    logToConsole('✅ Daily report sent to Slack');
  } catch (e) {
    console.error('[report error]', e);
  }
});

// SIGTERM/SIGINT で graceful shutdown
process.on('SIGTERM', () => { logToConsole('Shutting down...'); process.exit(0); });
process.on('SIGINT', () => { logToConsole('Shutting down...'); process.exit(0); });
