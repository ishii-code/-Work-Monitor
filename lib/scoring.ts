import Anthropic from '@anthropic-ai/sdk';
import {
  getDailySummaryFromCloud,
  listMissions,
  listClassificationRules,
  getCalendarEvents,
  upsertDailyScore,
  upsertClassificationRule,
  getDailyScore,
} from './cloud-db.js';

export interface ScoreResult {
  date: string;
  employee_id: number;
  mission_fit_score: number;
  waste_reduction_score: number;
  ai_progress_score: number;
  total_score: number;
  breakdown: {
    classifications: Array<{ app_name: string; category: string; classification: 'A' | 'B' | 'C'; reason: string; total_minutes: number }>;
    mission_links: Array<{ mission_id: number; title: string; relevance: number; minutes: number }>;
    calendar_analysis: Array<{ event_id: string; title: string; mission_related: boolean; meeting_type: string }>;
    new_rules: Array<{ app_name: string; category: string; classification: string; reason: string }>;
  };
}

function yesterday(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function calcDailyScore(employeeId: number, date: string): Promise<ScoreResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY が未設定です');

  const [summary, missions, rules, calEvents, prevScore] = await Promise.all([
    getDailySummaryFromCloud(employeeId, date),
    listMissions(employeeId),
    listClassificationRules(),
    getCalendarEvents(employeeId, date),
    getDailyScore(employeeId, yesterday(date)),
  ]);

  const appsLines = summary.top_apps.map((a) => `- ${a.app_name}: ${Math.round(a.total_seconds / 60)}分`).join('\n');
  const catLines = summary.categories.map((c) => `- ${c.category}: ${Math.round(c.total_seconds / 60)}分`).join('\n');
  const missionLines = missions.length === 0
    ? '(ミッション未設定)'
    : missions.map((m) => `- [#${m.id}] (優先度${m.priority}) ${m.title}${m.description ? ': ' + m.description : ''}`).join('\n');
  const calLines = calEvents.length === 0
    ? '(イベントなし)'
    : calEvents.map((e) => `- [${e.event_id}] ${e.title} (${e.meeting_type})`).join('\n');
  const ruleLines = rules.length === 0
    ? '(なし)'
    : rules.slice(0, 50).map((r) => `- ${r.app_name}/${r.category} = ${r.classification} (${r.reason ?? ''})`).join('\n');

  let prevASeconds = 0;
  if (prevScore && prevScore.breakdown && typeof prevScore.breakdown === 'object') {
    const bd = prevScore.breakdown as { classifications?: Array<{ classification?: string; total_minutes?: number }> };
    if (Array.isArray(bd.classifications)) {
      for (const c of bd.classifications) {
        if (c.classification === 'A') prevASeconds += (c.total_minutes ?? 0) * 60;
      }
    }
  }

  const prompt = `あなたは業務効率分析の専門家です。以下を JSON で返してください。

【今日の作業ログ - カテゴリ別】
${catLines || '(なし)'}

【今日の使用アプリ TOP】
${appsLines || '(なし)'}

【社員のミッション】
${missionLines}

【今日のカレンダーイベント】
${calLines}

【既存の分類ルール（参考）】
${ruleLines}

【昨日の分類A合計時間】${Math.round(prevASeconds / 60)}分

回答フォーマット（必ず以下の JSON 1 個のみ、コメント禁止）:
\`\`\`json
{
  "classifications": [
    {"app_name":"...","category":"...","classification":"A|B|C","reason":"...","total_minutes":0}
  ],
  "mission_links": [
    {"mission_id":0,"title":"...","relevance":0,"minutes":0}
  ],
  "calendar_analysis": [
    {"event_id":"...","title":"...","mission_related":true,"meeting_type":"internal|external|focus"}
  ],
  "mission_fit_score": 0,
  "waste_reduction_score": 0,
  "ai_progress_score": 0,
  "new_rules": [
    {"app_name":"...","category":"...","classification":"A|B|C","reason":"..."}
  ]
}
\`\`\`

評価基準:
- classification A = AI化可能, B = 必須でAI化困難, C = 不要でAI化困難
- mission_fit_score (0-100): 各業務の relevance × minutes 加重平均を正規化
- waste_reduction_score (0-100): (A+C) / (A+B+C) の minutes 比率を 100 点満点に換算 (Bは除外)
- ai_progress_score (0-100): 前日比でA分類が減っていれば 50+減少率*50、増えていれば 50-増加率*50（昨日 ${Math.round(prevASeconds / 60)}分）
- new_rules: 既存ルールにない app_name × category の組み合わせのみ`;

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) throw new Error('Claude のレスポンスに JSON ブロックがありません');

  let parsed: {
    classifications?: Array<{ app_name?: string; category?: string; classification?: string; reason?: string; total_minutes?: number }>;
    mission_links?: Array<{ mission_id?: number; title?: string; relevance?: number; minutes?: number }>;
    calendar_analysis?: Array<{ event_id?: string; title?: string; mission_related?: boolean; meeting_type?: string }>;
    mission_fit_score?: number;
    waste_reduction_score?: number;
    ai_progress_score?: number;
    new_rules?: Array<{ app_name?: string; category?: string; classification?: string; reason?: string }>;
  };
  try { parsed = JSON.parse(m[1]!); } catch { throw new Error('JSON パース失敗: ' + (m[1]?.slice(0, 200) ?? '')); }

  const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const missionFit = clamp(parsed.mission_fit_score);
  const waste = clamp(parsed.waste_reduction_score);
  const ai = clamp(parsed.ai_progress_score);
  const total = Math.round(missionFit * 0.5 + waste * 0.3 + ai * 0.2);

  const classifications = (parsed.classifications ?? []).map((c) => ({
    app_name: String(c.app_name ?? '').slice(0, 255),
    category: String(c.category ?? '').slice(0, 64),
    classification: (['A', 'B', 'C'].includes(String(c.classification)) ? c.classification : 'B') as 'A' | 'B' | 'C',
    reason: String(c.reason ?? '').slice(0, 500),
    total_minutes: Math.max(0, Number(c.total_minutes) || 0),
  }));
  const mission_links = (parsed.mission_links ?? []).map((l) => ({
    mission_id: Number(l.mission_id) || 0,
    title: String(l.title ?? '').slice(0, 200),
    relevance: Math.max(0, Math.min(10, Number(l.relevance) || 0)),
    minutes: Math.max(0, Number(l.minutes) || 0),
  }));
  const calendar_analysis = (parsed.calendar_analysis ?? []).map((c) => ({
    event_id: String(c.event_id ?? ''),
    title: String(c.title ?? '').slice(0, 200),
    mission_related: !!c.mission_related,
    meeting_type: String(c.meeting_type ?? 'internal'),
  }));
  const new_rules = (parsed.new_rules ?? []).map((r) => ({
    app_name: String(r.app_name ?? '').slice(0, 255),
    category: String(r.category ?? '').slice(0, 64),
    classification: String(r.classification ?? 'B').slice(0, 4),
    reason: String(r.reason ?? '').slice(0, 500),
  })).filter((r) => r.app_name && r.category);

  for (const nr of new_rules) {
    try { await upsertClassificationRule(nr.app_name, nr.category, nr.classification, nr.reason, null); } catch { /* ignore */ }
  }

  const breakdown = { classifications, mission_links, calendar_analysis, new_rules };
  await upsertDailyScore(employeeId, date, { mission: missionFit, waste, ai, total, breakdown });

  return {
    date,
    employee_id: employeeId,
    mission_fit_score: missionFit,
    waste_reduction_score: waste,
    ai_progress_score: ai,
    total_score: total,
    breakdown,
  };
}
