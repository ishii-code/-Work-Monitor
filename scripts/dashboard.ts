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
import { randomBytes } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const require = createRequire(import.meta.url);
const axios = require('axios') as typeof import('axios').default;

function maskTail(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? '*'.repeat(value.length) : '…' + value.slice(-4);
}

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

app.get('/api/settings', (_req, res) => {
  res.json({
    cloud_api_url: process.env.CLOUD_API_URL ?? null,
    employee_api_key_set: !!process.env.EMPLOYEE_API_KEY,
    employee_api_key_suffix: maskTail(process.env.EMPLOYEE_API_KEY),
    admin_api_key_set: !!process.env.ADMIN_API_KEY,
    admin_api_key_suffix: maskTail(process.env.ADMIN_API_KEY),
    slack_webhook_set: !!process.env.SLACK_WEBHOOK_URL,
    anthropic_api_key_set: !!process.env.ANTHROPIC_API_KEY,
    database_url_set: !!process.env.DATABASE_URL,
  });
});

app.post('/api/settings/test', async (_req, res) => {
  const cloudUrl = process.env.CLOUD_API_URL;
  if (!cloudUrl) {
    res.status(400).json({ ok: false, error: 'CLOUD_API_URL が未設定です' });
    return;
  }
  const endpoint = `${cloudUrl.replace(/\/$/, '')}/api/health`;
  const start = Date.now();
  try {
    const r = await axios.get(endpoint, { timeout: 10_000, validateStatus: () => true });
    res.json({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      latency_ms: Date.now() - start,
      endpoint,
      body: r.data,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    res.status(502).json({ ok: false, error: msg.slice(0, 200), endpoint });
  }
});

app.post('/api/settings/generate-key', (_req, res) => {
  const key = randomBytes(24).toString('base64url');
  res.json({ api_key: key });
});

app.get('/api/admin/ai-suggestion/:employeeId', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: 'ANTHROPIC_API_KEY が未設定です' });
    return;
  }
  const employeeId = Number(req.params.employeeId);
  if (!Number.isFinite(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: 'invalid employeeId' });
    return;
  }

  const cloudUrl = process.env.CLOUD_API_URL;
  const adminKey = process.env.ADMIN_API_KEY;
  const date = new Date().toLocaleDateString('sv-SE');

  let employees: Array<{ employee_id: number; name: string; categories: Array<{ category: string; total_seconds: number }>; top_apps: Array<{ app_name: string; total_seconds: number }>; total_seconds: number; idle_seconds: number }> = [];
  if (cloudUrl && adminKey) {
    try {
      const r = await axios.get(`${cloudUrl.replace(/\/$/, '')}/api/admin/monitor?date=${encodeURIComponent(date)}`, {
        headers: { 'X-API-Key': adminKey },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300 && r.data && Array.isArray(r.data.employees)) {
        employees = r.data.employees;
      }
    } catch {
      // fall through to mock below
    }
  }
  if (employees.length === 0) {
    employees = buildMockMonitor(date).employees;
  }

  const target = employees.find((e) => e.employee_id === employeeId);
  if (!target) {
    res.status(404).json({ error: 'employee not found' });
    return;
  }

  const catLines = target.categories.map((c) => `- ${c.category}: ${Math.round(c.total_seconds / 60)}分`).join('\n');
  const appLines = target.top_apps.map((a) => `- ${a.app_name}: ${Math.round(a.total_seconds / 60)}分`).join('\n');
  const prompt = `以下は社員「${target.name}」の今日の作業ログです。繰り返し作業・手動作業・時間がかかっている作業を分析し、AI や自動化で効率化できる上位3つを提案してください。
日本語で、具体的なツール名（Claude / ChatGPT / Zapier / Python等）を含めて提案してください。

【カテゴリ別】
${catLines || '(記録なし)'}

【使用アプリ】
${appLines || '(記録なし)'}

【その他】
合計稼働: ${Math.round(target.total_seconds / 60)}分
アイドル: ${Math.round(target.idle_seconds / 60)}分

回答フォーマット:
1. 【タイトル】要約（1〜2行）→ 推奨ツール: XXX
2. 【タイトル】...
3. 【タイトル】...`;

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter((s) => s.length > 0)
      .join('\n')
      .trim();
    res.json({
      ok: true,
      employee: { id: target.employee_id, name: target.name },
      suggestion: text,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : 'anthropic error';
    res.status(500).json({ error: m.slice(0, 300) });
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
