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
import {
  ensureDefaultAdmin,
  createAuthRouter,
  createUserAdminRouter,
  createMonitorRouter,
  requireAuth,
  requireAdmin,
  type WmUser,
} from '../lib/auth.js';
import {
  initCloudSchema,
  getMonitorOverview,
  getDailySummaryFromCloud,
  getWeeklySummaryFromCloud,
  getOnboardingStatus,
  listAllEmployees,
  linkUserEmployee,
  findEmployeeByEmail,
  recordMonitoringLog,
  getLatestMonitoringStatus,
  listMonitoringLogs,
  listMissions,
  listAllMissions,
  createMission,
  updateMission,
  deleteMission,
  listClassificationRules,
  updateClassificationRule,
  listClassificationHistory,
  getDailyScore,
  getScoreHistory,
  getAllTodayScores,
  getAllScoreHistory,
  getCalendarTokens,
  getCalendarEvents,
  getAllCalendarEvents,
  listAllCalendarEmployees,
  insertAiSuggestionLog,
  markSpmProjectCreated,
  getAiStatusPerEmployee,
} from '../lib/cloud-db.js';
import { createActivityRouter } from '../lib/server.js';
import { calcDailyScore } from '../lib/scoring.js';
import { buildAuthUrl, handleOAuthCallback, syncCalendar } from '../lib/calendar.js';
import cron from 'node-cron';

const require = createRequire(import.meta.url);
const axios = require('axios') as typeof import('axios').default;

const CLOUD_MODE = !!process.env.DATABASE_URL;

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
const PORT = Number(process.env.PORT ?? 3011);

app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// クラウドモード時のみ
//   - 社員PC daemon → /api/activities 受信 (X-API-Key 認証)
//   - JWT 認証 + 認証 API + ユーザー管理 + /api/monitor
if (CLOUD_MODE) {
  app.use(createActivityRouter({
    onAfterInsert: async (employee, accepted, wasFirst) => {
      if (!wasFirst || accepted <= 0) return;
      if (!process.env.SLACK_WEBHOOK_URL) {
        console.warn('[onboarding-slack] SLACK_WEBHOOK_URL 未設定のため通知スキップ');
        return;
      }
      try {
        await sendToSlack(`✅ ${employee.name}さんのWork Monitorが起動しました！`);
      } catch (e) {
        console.error('[onboarding-slack] 送信失敗:', e instanceof Error ? e.message : String(e));
      }
    },
  }));
  app.use(createAuthRouter());
  app.use(createUserAdminRouter());
  app.use(createMonitorRouter());

  app.get('/api/admin/employees', requireAuth, requireAdmin, async (_req, res) => {
    try {
      res.json({ employees: await listAllEmployees() });
    } catch (e) {
      res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
    }
  });

  app.post('/api/admin/users/:id/link-employee', requireAuth, requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      res.status(400).json({ error: 'invalid user id' });
      return;
    }
    const body = (req.body ?? {}) as { employeeId?: unknown; autoMatch?: unknown };
    let empId: number | null = null;
    if (typeof body.employeeId === 'number' && Number.isFinite(body.employeeId)) {
      empId = body.employeeId;
    } else if (body.autoMatch === true) {
      const { getUserById } = await import('../lib/auth.js');
      const u = await getUserById(userId);
      if (!u) { res.status(404).json({ error: 'user not found' }); return; }
      const match = await findEmployeeByEmail(u.email);
      if (!match) { res.status(404).json({ error: 'メール一致する employee が見つかりません' }); return; }
      empId = match.id;
    } else {
      res.status(400).json({ error: 'employeeId か autoMatch:true が必須です' });
      return;
    }
    try {
      const ok = await linkUserEmployee(userId, empId);
      if (!ok) { res.status(404).json({ error: 'user not found' }); return; }
      res.json({ ok: true, employeeId: empId });
    } catch (e) {
      res.status(500).json({ error: 'link failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
    }
  });

  app.get('/api/admin/onboarding', requireAuth, requireAdmin, async (_req, res) => {
    try {
      res.json(await getOnboardingStatus());
    } catch (e) {
      const m = e instanceof Error ? e.message : 'unknown';
      res.status(500).json({ error: 'onboarding fetch failed', detail: m.slice(0, 200) });
    }
  });

  app.post('/api/monitoring/stop', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user) { res.status(401).json({ error: 'unauthenticated' }); return; }
    if (!user.employee_id) { res.status(400).json({ error: 'employee_id が紐づいていません' }); return; }
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    try {
      await recordMonitoringLog(user.employee_id, 'stop', reason || null);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
    }
  });

  app.post('/api/monitoring/start', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user) { res.status(401).json({ error: 'unauthenticated' }); return; }
    if (!user.employee_id) { res.status(400).json({ error: 'employee_id が紐づいていません' }); return; }
    try {
      await recordMonitoringLog(user.employee_id, 'start', null);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
    }
  });

  app.get('/api/monitoring/me', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user) { res.status(401).json({ error: 'unauthenticated' }); return; }
    if (!user.employee_id) { res.json({ status: null, employee_id: null }); return; }
    try {
      const status = await getLatestMonitoringStatus(user.employee_id);
      res.json({ status: status ?? 'start', employee_id: user.employee_id });
    } catch (e) {
      res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
    }
  });

  app.get('/api/admin/monitoring-logs', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const logs = await listMonitoringLogs();
      res.json({ logs });
    } catch (e) {
      res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
    }
  });

  // ── Missions ──
  app.get('/api/missions', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.json({ missions: [] }); return; }
    try { res.json({ missions: await listMissions(user.employee_id) }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.post('/api/missions', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    const body = (req.body ?? {}) as { title?: unknown; description?: unknown; priority?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) { res.status(400).json({ error: 'title 必須' }); return; }
    const description = typeof body.description === 'string' ? body.description : null;
    const priority = typeof body.priority === 'number' ? body.priority : 1;
    try { res.json({ ok: true, mission: await createMission(user.employee_id, title, description, priority) }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.put('/api/missions/:id', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const body = (req.body ?? {}) as { title?: unknown; description?: unknown; priority?: unknown; is_active?: unknown };
    const fields: { title?: string; description?: string | null; priority?: number; is_active?: boolean } = {};
    if (typeof body.title === 'string') fields.title = body.title;
    if (body.description === null || typeof body.description === 'string') fields.description = body.description as string | null;
    if (typeof body.priority === 'number') fields.priority = body.priority;
    if (typeof body.is_active === 'boolean') fields.is_active = body.is_active;
    try { const ok = await updateMission(id, user.employee_id, fields); res.json({ ok }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.delete('/api/missions/:id', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    const id = Number(req.params.id);
    try { const ok = await deleteMission(id, user.employee_id); res.json({ ok }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/admin/missions', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json({ missions: await listAllMissions() }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });

  // ── Scores ──
  app.get('/api/score/today', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    const date = new Date().toLocaleDateString('sv-SE');
    try {
      const score = await calcDailyScore(user.employee_id, date);
      res.json(score);
    } catch (e) {
      res.status(500).json({ error: (e instanceof Error ? e.message : 'failed').slice(0, 300) });
    }
  });
  app.get('/api/score/history', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.json({ scores: [] }); return; }
    try { res.json({ scores: await getScoreHistory(user.employee_id, 30) }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/admin/scores', requireAuth, requireAdmin, async (_req, res) => {
    const date = new Date().toLocaleDateString('sv-SE');
    try { res.json({ scores: await getAllTodayScores(date) }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/admin/scores/history', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json({ scores: await getAllScoreHistory(30) }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });

  // ── Classification rules ──
  app.get('/api/admin/classification-rules', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json({ rules: await listClassificationRules() }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.put('/api/admin/classification-rules/:id', requireAuth, requireAdmin, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user!;
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as { classification?: unknown; reason?: unknown };
    const cls = typeof body.classification === 'string' ? body.classification : '';
    if (!['A', 'B', 'C'].includes(cls)) { res.status(400).json({ error: 'classification は A/B/C' }); return; }
    const reason = typeof body.reason === 'string' ? body.reason : null;
    try { const ok = await updateClassificationRule(id, cls, reason, user.id); res.json({ ok }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/admin/classification-history', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json({ history: await listClassificationHistory() }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });

  // ── Calendar ──
  app.get('/api/calendar/auth', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    try {
      const url = buildAuthUrl(String(user.employee_id));
      res.json({ url });
    } catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/calendar/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const employeeId = Number(state);
    if (!code || !Number.isFinite(employeeId)) { res.status(400).send('invalid callback'); return; }
    try {
      await handleOAuthCallback(code, employeeId);
      res.redirect('/');
    } catch (e) {
      res.status(500).send('OAuth failed: ' + (e instanceof Error ? e.message : '').slice(0, 200));
    }
  });
  app.get('/api/calendar/sync', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    const date = new Date().toLocaleDateString('sv-SE');
    try { const count = await syncCalendar(user.employee_id, date); res.json({ ok: true, count }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/calendar/events', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.json({ events: [], connected: false }); return; }
    const date = new Date().toLocaleDateString('sv-SE');
    try {
      const tokens = await getCalendarTokens(user.employee_id);
      const events = await getCalendarEvents(user.employee_id, date);
      res.json({ events, connected: !!tokens });
    } catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });
  app.get('/api/admin/calendar/events', requireAuth, requireAdmin, async (_req, res) => {
    const date = new Date().toLocaleDateString('sv-SE');
    try { res.json({ events: await getAllCalendarEvents(date) }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });

  // ── AI suggestion (USER + ADMIN) ──
  async function runAiSuggestion(employeeId: number, employeeName: string, type: 'daily' | 'weekly'): Promise<{ suggestion: string; actions: Array<{ title: string; description: string; projectType: string; businessCategory: string }>; logId: number }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY が未設定です');
    const today = new Date().toLocaleDateString('sv-SE');
    let promptIntro: string;
    let catLines = '';
    let appLines = '';
    if (type === 'daily') {
      const summary = await getDailySummaryFromCloud(employeeId, today);
      catLines = summary.categories.map((c) => `- ${c.category}: ${Math.round(c.total_seconds / 60)}分`).join('\n');
      appLines = summary.top_apps.map((a) => `- ${a.app_name}: ${Math.round(a.total_seconds / 60)}分`).join('\n');
      promptIntro = `以下は社員「${employeeName}」の今日の作業ログです。`;
    } else {
      const days = await getWeeklySummaryFromCloud(employeeId);
      const catTotals = new Map<string, number>();
      const appTotals = new Map<string, number>();
      for (const d of days) {
        for (const c of d.categories) catTotals.set(c.category, (catTotals.get(c.category) ?? 0) + c.total_seconds);
        for (const a of d.top_apps) appTotals.set(a.app_name, (appTotals.get(a.app_name) ?? 0) + a.total_seconds);
      }
      catLines = Array.from(catTotals.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${Math.round(v / 60)}分`).join('\n');
      appLines = Array.from(appTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `- ${k}: ${Math.round(v / 60)}分`).join('\n');
      promptIntro = `以下は社員「${employeeName}」の過去7日間の作業ログ集計です。今週最も時間を使った業務トップ5・各業務のA/B/C分類・AI化できる業務の具体的な提案・来週のアクション・先週比の改善状況を含めて回答してください。`;
    }
    const prompt = `${promptIntro}
繰り返し作業・手動作業・時間がかかっている作業を分析し、AI や自動化で効率化できる上位3つを提案してください。
日本語で、具体的なツール名（Claude / ChatGPT / Zapier / Python等）を含めて提案してください。

【カテゴリ別】
${catLines || '(記録なし)'}

【使用アプリ】
${appLines || '(記録なし)'}

まず人間が読める提案を出し、その後に同じ内容を spm-dev-agent 用の JSON で返してください。
businessCategory は以下から選択: dev_tools / sales / marketing / hr / finance / operations / customer_support / other

回答フォーマット:
1. 【タイトル】要約（1〜2行）→ 推奨ツール: XXX
2. 【タイトル】...
3. 【タイトル】...

\`\`\`json
{
  "actions": [
    {"title": "○○業務の自動化", "description": "詳細な要件説明（5〜10文）", "projectType": "new", "businessCategory": "dev_tools"}
  ]
}
\`\`\``;
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).filter((s) => s.length > 0).join('\n').trim();
    let actions: Array<{ title: string; description: string; projectType: string; businessCategory: string }> = [];
    let humanText = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed && Array.isArray(parsed.actions)) {
          actions = parsed.actions
            .filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === 'object')
            .map((a: Record<string, unknown>) => ({
              title: String(a.title ?? '').slice(0, 200),
              description: String(a.description ?? '').slice(0, 2000),
              projectType: String(a.projectType ?? 'new').slice(0, 32),
              businessCategory: String(a.businessCategory ?? 'other').slice(0, 32),
            }))
            .filter((a: { title: string }) => a.title.length > 0);
        }
      } catch { /* ignore */ }
      humanText = text.replace(/```json[\s\S]*?```/, '').trim();
    }
    const logId = await insertAiSuggestionLog(employeeId, type, humanText, actions);
    return { suggestion: humanText, actions, logId };
  }

  app.get('/api/score/ai-suggestion', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    try {
      const result = await runAiSuggestion(user.employee_id, user.name, 'daily');
      res.json({ ok: true, employee: { id: user.employee_id, name: user.name }, ...result, spm_dev_agent_configured: !!process.env.SPM_DEV_AGENT_URL });
    } catch (e) {
      res.status(500).json({ error: (e instanceof Error ? e.message : 'failed').slice(0, 300) });
    }
  });

  app.get('/api/week/ai-suggestion', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user?.employee_id) { res.status(400).json({ error: 'employee_id 未紐づけ' }); return; }
    try {
      const result = await runAiSuggestion(user.employee_id, user.name, 'weekly');
      res.json({ ok: true, employee: { id: user.employee_id, name: user.name }, ...result, spm_dev_agent_configured: !!process.env.SPM_DEV_AGENT_URL });
    } catch (e) {
      res.status(500).json({ error: (e instanceof Error ? e.message : 'failed').slice(0, 300) });
    }
  });

  app.get('/api/admin/ai-status', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json({ employees: await getAiStatusPerEmployee() }); }
    catch (e) { res.status(500).json({ error: (e instanceof Error ? e.message : '').slice(0, 200) }); }
  });

  // ── Daily 08:00 cron: 全社員のカレンダー同期 ──
  cron.schedule('0 8 * * *', async () => {
    const date = new Date().toLocaleDateString('sv-SE');
    try {
      const emps = await listAllCalendarEmployees();
      for (const empId of emps) {
        try { await syncCalendar(empId, date); }
        catch (e) { console.error('[cron calendar sync] emp=' + empId + ' failed:', e instanceof Error ? e.message : String(e)); }
      }
      console.log(`[cron] calendar sync done for ${emps.length} employees`);
    } catch (e) {
      console.error('[cron calendar sync] fatal:', e instanceof Error ? e.message : String(e));
    }
  });

  app.get('/api/onboarding/me', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    try {
      const rows = await getOnboardingStatus(user.id);
      res.json(rows[0] ?? null);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'unknown';
      res.status(500).json({ error: 'onboarding fetch failed', detail: m.slice(0, 200) });
    }
  });
}

// ── API ──────────────────────────────────────────────

if (CLOUD_MODE) {
  app.get('/api/today', requireAuth, async (req, res) => {
    const date = new Date().toLocaleDateString('sv-SE');
    const user = (req as unknown as { user?: WmUser }).user;
    const employeeId = user?.employee_id ?? null;
    const empty = {
      summary: { date, total_tracked_seconds: 0, idle_seconds: 0, categories: [], top_apps: [] },
      activities: [],
    };
    if (!employeeId) {
      res.json({ ...empty, note: 'no employee_id linked to this user' });
      return;
    }
    try {
      const summary = await getDailySummaryFromCloud(employeeId, date);
      res.json({ summary, activities: [] });
    } catch (e) {
      const m = e instanceof Error ? e.message : 'unknown';
      res.status(500).json({ error: 'failed to load today', detail: m.slice(0, 200) });
    }
  });

  app.get('/api/week', requireAuth, async (req, res) => {
    const user = (req as unknown as { user?: WmUser }).user;
    const employeeId = user?.employee_id ?? null;
    if (!employeeId) {
      const days: object[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const date = d.toLocaleDateString('sv-SE');
        days.push({ date, total_tracked_seconds: 0, idle_seconds: 0, categories: [], top_apps: [] });
      }
      res.json(days);
      return;
    }
    try {
      const days = await getWeeklySummaryFromCloud(employeeId);
      res.json(days);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'unknown';
      res.status(500).json({ error: 'failed to load week', detail: m.slice(0, 200) });
    }
  });
} else {
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
}

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
  if (CLOUD_MODE) {
    res.json({ running: true, cloud: true, detail: 'cloud mode' });
    return;
  }
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

// 旧 /api/admin/monitor は廃止。CLOUD_MODE では auth.ts が /api/monitor を mount。
// 非 CLOUD_MODE（ローカル単体・DBなし）ではモックを返し、auth/me はダミー ADMIN を返す。
if (!CLOUD_MODE) {
  app.get('/api/monitor', (req, res) => {
    const dateParam = typeof req.query.date === 'string' ? req.query.date : '';
    const date = ISO_DATE_RE.test(dateParam) ? dateParam : new Date().toLocaleDateString('sv-SE');
    res.json({ ...buildMockMonitor(date), role: 'ADMIN' });
  });
  app.get('/api/auth/me', (_req, res) => {
    res.json({
      user: {
        id: 0, name: 'ローカルユーザー', email: 'local@local', role: 'ADMIN',
        must_change_password: false, employee_id: null, last_login_at: null, created_at: new Date().toISOString(),
      },
    });
  });
  app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));
  app.get('/api/admin/users', (_req, res) => res.json({ users: [] }));
}

app.get('/api/settings', (_req, res) => {
  res.json({
    database_url_set: !!process.env.DATABASE_URL,
    admin_api_key_set: !!process.env.ADMIN_API_KEY,
    auth_secret_set: !!(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16),
    anthropic_api_key_set: !!process.env.ANTHROPIC_API_KEY,
    slack_webhook_set: !!process.env.SLACK_WEBHOOK_URL,
  });
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
  if (CLOUD_MODE) {
    try {
      const { getMonitorOverview } = await import('../lib/cloud-db.js');
      const rows = await getMonitorOverview(date);
      employees = rows;
    } catch {
      // fall through to mock
    }
  } else if (cloudUrl && adminKey) {
    try {
      const r = await axios.get(`${cloudUrl.replace(/\/$/, '')}/api/monitor?date=${encodeURIComponent(date)}`, {
        headers: { 'X-API-Key': adminKey },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300 && r.data && Array.isArray(r.data.employees)) {
        employees = r.data.employees;
      }
    } catch {
      // fall through to mock
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

まず人間が読める提案を出し、その後に同じ内容を spm-dev-agent 用の JSON で返してください。
businessCategory は以下から選択: dev_tools / sales / marketing / hr / finance / operations / customer_support / other

回答フォーマット:
1. 【タイトル】要約（1〜2行）→ 推奨ツール: XXX
2. 【タイトル】...
3. 【タイトル】...

\`\`\`json
{
  "actions": [
    {"title": "○○業務の自動化", "description": "詳細な要件説明（5〜10文）", "projectType": "new", "businessCategory": "dev_tools"}
  ]
}
\`\`\``;

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter((s) => s.length > 0)
      .join('\n')
      .trim();

    let actions: Array<{ title: string; description: string; projectType: string; businessCategory: string }> = [];
    let humanText = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed && Array.isArray(parsed.actions)) {
          actions = parsed.actions
            .filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === 'object')
            .map((a: Record<string, unknown>) => ({
              title: String(a.title ?? '').slice(0, 200),
              description: String(a.description ?? '').slice(0, 2000),
              projectType: String(a.projectType ?? 'new').slice(0, 32),
              businessCategory: String(a.businessCategory ?? 'other').slice(0, 32),
            }))
            .filter((a: { title: string }) => a.title.length > 0);
        }
      } catch {
        // JSON parse failed; keep actions empty
      }
      humanText = text.replace(/```json[\s\S]*?```/, '').trim();
    }

    res.json({
      ok: true,
      employee: { id: target.employee_id, name: target.name },
      suggestion: humanText,
      actions,
      spm_dev_agent_configured: !!process.env.SPM_DEV_AGENT_URL,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : 'anthropic error';
    res.status(500).json({ error: m.slice(0, 300) });
  }
});

app.post('/api/admin/create-project', async (req, res) => {
  const body = (req.body ?? {}) as { employeeName?: unknown; action?: unknown; logId?: unknown };
  const employeeName = typeof body.employeeName === 'string' ? body.employeeName.slice(0, 100) : '';
  const action = body.action && typeof body.action === 'object' ? (body.action as Record<string, unknown>) : null;
  const logId = typeof body.logId === 'number' && Number.isFinite(body.logId) ? body.logId : null;
  if (!employeeName || !action) {
    res.status(400).json({ error: 'employeeName と action が必須です' });
    return;
  }
  const title = typeof action.title === 'string' ? action.title.slice(0, 200) : '';
  const description = typeof action.description === 'string' ? action.description.slice(0, 4000) : '';
  const projectType = typeof action.projectType === 'string' ? action.projectType.slice(0, 32) : 'new';
  const businessCategory = typeof action.businessCategory === 'string' ? action.businessCategory.slice(0, 32) : 'other';
  if (!title || !description) {
    res.status(400).json({ error: 'action.title と action.description が必須です' });
    return;
  }

  const agentUrl = process.env.SPM_DEV_AGENT_URL;
  if (!agentUrl) {
    const mockId = 'mock-' + Date.now().toString(36);
    if (logId !== null) { try { await markSpmProjectCreated(logId, mockId); } catch { /* ignore */ } }
    res.json({
      ok: true,
      mock: true,
      projectId: mockId,
      projectUrl: 'https://example.invalid/projects/' + mockId,
      message: 'SPM_DEV_AGENT_URL 未設定のためモックレスポンスを返しました',
    });
    return;
  }

  const authToken = process.env.AUTH_SECRET ?? req.header('x-admin-token') ?? '';
  const endpoint = `${agentUrl.replace(/\/$/, '')}/api/projects`;
  try {
    const upstream = await axios.post(
      endpoint,
      {
        name: `[${employeeName}] ${title}`,
        description,
        projectType,
        businessCategory,
        source: 'pc-work-monitor',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'X-Admin-Token': authToken, Authorization: `Bearer ${authToken}` } : {}),
        },
        timeout: 30_000,
        validateStatus: () => true,
      }
    );
    if (upstream.status >= 200 && upstream.status < 300 && upstream.data) {
      const data = upstream.data as { id?: string | number; projectId?: string | number; url?: string; projectUrl?: string };
      const projectId = String(data.projectId ?? data.id ?? '');
      const projectUrl = String(
        data.projectUrl ?? data.url ?? `${agentUrl.replace(/\/$/, '')}/projects/${projectId}`
      );
      if (logId !== null && projectId) { try { await markSpmProjectCreated(logId, projectId); } catch { /* ignore */ } }
      res.json({ ok: true, projectId, projectUrl });
    } else {
      res.status(upstream.status || 502).json({
        error: 'spm-dev-agent への作成リクエストが失敗しました',
        status: upstream.status,
        detail: typeof upstream.data === 'string' ? upstream.data.slice(0, 200) : upstream.data,
      });
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : 'network error';
    res.status(502).json({ error: 'spm-dev-agent への接続に失敗しました', detail: m.slice(0, 200) });
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

async function bootstrap(): Promise<void> {
  if (CLOUD_MODE) {
    await initCloudSchema();
    await ensureDefaultAdmin();
  }
  app.listen(PORT, () => {
    console.log(`\n📊 ${CLOUD_MODE ? 'クラウド' : 'ローカル'}ダッシュボード: http://localhost:${PORT}\n`);
  });
}

bootstrap().catch((e) => {
  console.error('[dashboard] fatal:', e);
  process.exit(1);
});
