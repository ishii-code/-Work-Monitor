import Anthropic from '@anthropic-ai/sdk';
import type { DailySummary, AIInsight } from './types.js';
import { CATEGORY_LABELS, formatDuration } from './categorizer.js';

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildSummaryText(summary: DailySummary): string {
  const lines: string[] = [
    `【${summary.date} 作業サマリー】`,
    `合計追跡時間: ${formatDuration(summary.total_tracked_seconds)}`,
    `アイドル時間: ${formatDuration(summary.idle_seconds)}`,
    '',
    '【カテゴリ別時間】',
  ];

  for (const cat of summary.categories) {
    const label = CATEGORY_LABELS[cat.category];
    const pct = summary.total_tracked_seconds > 0
      ? Math.round((cat.total_seconds / summary.total_tracked_seconds) * 100)
      : 0;
    lines.push(`${label}: ${formatDuration(cat.total_seconds)} (${pct}%)`);
    for (const app of cat.apps.slice(0, 3)) {
      lines.push(`  - ${app.app_name}: ${formatDuration(app.total_seconds)}`);
      if (app.window_titles.length > 0) {
        lines.push(`    タイトル例: ${app.window_titles.slice(0, 2).join(' / ')}`);
      }
    }
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `あなたはPC作業効率化の専門AIです。1日の作業ログを分析し、以下を日本語でJSONとして返してください。

【出力フォーマット（JSON）】
{
  "summary": "一言で今日の作業評価（例：コア開発集中型の充実した一日）",
  "efficiency_score": 0から100の数値（100=理想的な時間配分）,
  "suggestions": [
    {
      "category": "カテゴリ名",
      "task_description": "具体的な作業内容（例：Slackへのメッセージ返信）",
      "time_spent_minutes": 消費時間分,
      "automation_type": "automation|batch|ai_assist|eliminate",
      "agent_name": "推奨AIエージェント名（例：Slack返信下書きBot）",
      "estimated_savings_minutes": 削減できる分数,
      "priority": "high|medium|low"
    }
  ],
  "action_items": ["明日すぐできる改善アクション（3つ）"]
}

【重要なルール】
- suggestionsは時間の多い順に最大5つ
- automation_typeの意味: automation=AIが完全自動化, batch=まとめ処理で効率化, ai_assist=AI補助で時間短縮, eliminate=やめるべき作業
- agent_nameは具体的なツール・Botの名前を提案
- efficiency_scoreの基準: 70点以上=コア業務が7割超, 50-70=改善余地あり, 50未満=要対策
- 全体のビジョン: ごう（石井豪）はSPMプロジェクト（動物病院AI医療基盤）のリードエンジニア。コア開発に最大時間を割くべき。
`;

export async function analyzeDay(summary: DailySummary): Promise<AIInsight> {
  const summaryText = buildSummaryText(summary);

  const response = await getClient().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: summaryText + '\n\n上記の作業ログをJSONで分析してください。',
      },
    ],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed: {
    summary?: string;
    efficiency_score?: number;
    suggestions?: AIInsight['suggestions'];
    action_items?: string[];
  } = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  return {
    date: summary.date,
    report_type: 'daily',
    summary: parsed.summary ?? '分析結果なし',
    time_breakdown: summary.categories,
    efficiency_score: parsed.efficiency_score ?? 50,
    suggestions: parsed.suggestions ?? [],
    action_items: parsed.action_items ?? [],
    created_at: new Date().toISOString(),
  };
}

export function formatInsightForSlack(insight: AIInsight, summary: DailySummary): string {
  const scoreEmoji = insight.efficiency_score >= 70 ? ':large_green_circle:' : insight.efficiency_score >= 50 ? ':large_yellow_circle:' : ':red_circle:';
  const lines: string[] = [
    `*:bar_chart: ${insight.date} 作業日報*`,
    `${scoreEmoji} 効率スコア: *${insight.efficiency_score}/100*`,
    `> ${insight.summary}`,
    '',
    `*:stopwatch: 時間配分 (合計 ${formatDuration(summary.total_tracked_seconds)})*`,
  ];

  for (const cat of summary.categories.slice(0, 5)) {
    const label = CATEGORY_LABELS[cat.category];
    const pct = Math.round((cat.total_seconds / summary.total_tracked_seconds) * 100);
    lines.push(`${label}: ${pct}% (${formatDuration(cat.total_seconds)})`);
  }

  if (insight.suggestions.length > 0) {
    lines.push('', '*:robot_face: AI自動化提案*');
    for (const s of insight.suggestions.slice(0, 3)) {
      const typeIcon: Record<string, string> = { automation: ':zap:', batch: ':package:', ai_assist: ':handshake:', eliminate: ':wastebasket:' };
      const icon = typeIcon[s.automation_type] ?? ':bulb:';
      lines.push(
        `${icon} *${s.task_description}* (${s.time_spent_minutes}分/日)\n` +
        `   → ${s.agent_name} で *${s.estimated_savings_minutes}分削減可能*`
      );
    }
  }

  if (insight.action_items.length > 0) {
    lines.push('', '*:white_check_mark: 明日のアクション*');
    insight.action_items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  }

  return lines.join('\n');
}
