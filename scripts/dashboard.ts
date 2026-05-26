import { loadEnv } from '../lib/load-env.js';
loadEnv();

import express from 'express';
import { getDailySummary, getTodayActivities, getLastInsight, getDb, deleteDayActivities } from '../lib/db.js';
import { analyzeDay, formatInsightForSlack } from '../lib/analyzer.js';
import { saveInsight } from '../lib/db.js';
import { sendToSlack } from '../lib/notifier.js';
import { CATEGORY_LABELS, formatDuration } from '../lib/categorizer.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const axios = require('axios') as typeof import('axios').default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildMockMonitor(date: string) {
  const now = new Date();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  return {
    date,
    mock: true,
    employees: [
      {
        employee_id: 1,
        name: '石井 豪（モック）',
        email: 'gou@example.com',
        total_seconds: 5 * 3600 + 32 * 60,
        idle_seconds: 38 * 60,
        last_seen: minutesAgo(2),
        categories: [
          { category: 'core_dev', total_seconds: 3 * 3600 + 12 * 60 },
          { category: 'communication', total_seconds: 1 * 3600 + 4 * 60 },
          { category: 'meeting', total_seconds: 46 * 60 },
          { category: 'research', total_seconds: 30 * 60 },
        ],
        top_apps: [
          { app_name: 'Cursor', total_seconds: 2 * 3600 + 18 * 60 },
          { app_name: 'iTerm2', total_seconds: 54 * 60 },
          { app_name: 'Slack', total_seconds: 1 * 3600 + 4 * 60 },
          { app_name: 'Google Chrome', total_seconds: 30 * 60 },
          { app_name: 'zoom.us', total_seconds: 46 * 60 },
        ],
      },
      {
        employee_id: 2,
        name: '山田 太郎（モック）',
        email: 'yamada@example.com',
        total_seconds: 3 * 3600 + 12 * 60,
        idle_seconds: 1 * 3600 + 5 * 60,
        last_seen: minutesAgo(22),
        categories: [
          { category: 'communication', total_seconds: 1 * 3600 + 30 * 60 },
          { category: 'admin', total_seconds: 1 * 3600 },
          { category: 'research', total_seconds: 42 * 60 },
        ],
        top_apps: [
          { app_name: 'Slack', total_seconds: 1 * 3600 + 30 * 60 },
          { app_name: 'Mail', total_seconds: 1 * 3600 },
          { app_name: 'Google Chrome', total_seconds: 42 * 60 },
        ],
      },
      {
        employee_id: 3,
        name: '佐藤 花子（モック）',
        email: 'sato@example.com',
        total_seconds: 0,
        idle_seconds: 0,
        last_seen: null,
        categories: [],
        top_apps: [],
      },
    ],
  };
}

const app = express();
const PORT = 3011;

app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ── API ──────────────────────────────────────────────

app.get('/api/today', (_req, res) => {
  const date = new Date().toLocaleDateString('sv-SE');
  const summary = getDailySummary(date);
  const activities = getTodayActivities(date);
  res.json({ summary, activities: activities.slice(-50).reverse() });
});

app.get('/api/week', (_req, res) => {
  const days: object[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toLocaleDateString('sv-SE');
    days.push(getDailySummary(date));
  }
  res.json(days);
});

app.get('/api/insight/:date', (req, res) => {
  const insight = getLastInsight(req.params.date);
  res.json(insight ?? { error: 'No insight for this date' });
});

app.post('/api/report', async (_req, res) => {
  try {
    const date = new Date().toLocaleDateString('sv-SE');
    const summary = getDailySummary(date);
    if (summary.total_tracked_seconds < 60) {
      res.json({ error: 'Not enough data' }); return;
    }
    const insight = await analyzeDay(summary);
    saveInsight(insight);
    const msg = formatInsightForSlack(insight, summary);
    await sendToSlack(msg);
    res.json({ ok: true, insight });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/status', (_req, res) => {
  try {
    const out = execSync('launchctl list | grep pc-work-monitor').toString().trim();
    const running = out.length > 0 && !out.startsWith('-');
    res.json({ running, detail: out });
  } catch {
    res.json({ running: false, detail: '' });
  }
});

app.post('/api/daemon/stop', (_req, res) => {
  try {
    execSync(`launchctl unload "${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist" 2>/dev/null`);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.post('/api/daemon/start', (_req, res) => {
  try {
    execSync(`launchctl load "${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/reset/:date', (req, res) => {
  const count = deleteDayActivities(req.params.date);
  res.json({ ok: true, deleted: count });
});

app.get('/api/admin/monitor', async (req, res) => {
  const dateParam = typeof req.query.date === 'string' ? req.query.date : '';
  const date = ISO_DATE_RE.test(dateParam) ? dateParam : new Date().toLocaleDateString('sv-SE');
  const cloudUrl = process.env.CLOUD_API_URL;
  const adminKey = process.env.ADMIN_API_KEY;

  if (!cloudUrl || !adminKey) {
    res.json(buildMockMonitor(date));
    return;
  }

  try {
    const upstream = await axios.get(
      `${cloudUrl.replace(/\/$/, '')}/api/admin/monitor?date=${encodeURIComponent(date)}`,
      {
        headers: { 'X-API-Key': adminKey },
        timeout: 15_000,
        validateStatus: () => true,
      }
    );
    res.status(upstream.status).json(upstream.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'upstream error';
    res.status(502).json({ error: 'cloud API unreachable', detail: msg.slice(0, 200) });
  }
});

app.get('/api/privacy-rules', (_req, res) => {
  res.json({
    blockedApps: ['1Password', '1Password 7', '1Password 8', 'Bitwarden', 'Keychain Access', 'LastPass', 'Dashlane', 'NordPass'],
    blockedUrlPatterns: ['smbc', 'mufg', 'mizuho', 'paypal', 'stripe', 'credit', 'card', 'payment', 'mynumber', 'nta.go.jp'],
    sanitizedPatterns: ['クレジットカード番号', '電話番号', 'password=...', 'token=...', 'api_key=...'],
  });
});

// ── HTML ─────────────────────────────────────────────
const HTML = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');

app.get('/', (_req, res) => { res.send(HTML); });

app.listen(PORT, () => {
  console.log(`\n📊 管理ダッシュボード: http://localhost:${PORT}\n`);
});
