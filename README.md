# pc-work-monitor

PC作業を10秒ごとに監視し、カテゴリ別に集計、毎日22時にClaude AIが効率化提案を生成してSlackへ送信するエージェント。

## セットアップ

### 1. アクセシビリティ権限の付与（必須）
システム設定 > プライバシーとセキュリティ > アクセシビリティ
→ Terminal（またはiTerm2）を追加してオン

### 2. .env の設定
```
ANTHROPIC_API_KEY=sk-ant-...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

### 3. LaunchAgent 登録（Mac起動時に自動起動）
```bash
launchctl load ~/Library/LaunchAgents/com.peco.pc-work-monitor.plist
```

### 4. 手動起動
```bash
npm run daemon
```

## 使い方

```bash
# ステータス確認（今日の集計）
npm run status

# 手動で日報生成
npm run report

# 今日のデータをリセット
npm run reset-today

# 特定日の日報
npm run report -- 2026-05-26
```

## カテゴリ
| カテゴリ | 内容 |
|---|---|
| core_dev | VSCode, Terminal, Claude Code |
| communication | Slack, メール |
| meeting | Zoom, Google Meet |
| research | ブラウザ（GitHub, Notion等） |
| ai_tool | Claude.ai, ChatGPT |
| admin | Finder, システム設定 |
| idle | 5分以上操作なし |

## AI日報サンプル
```
📊 2026-05-26 作業日報
🟢 効率スコア: 74/100
> コア開発集中型の充実した一日

⏱ 時間配分 (合計 8h30m)
⚙️ コア開発: 65% (5h32m)
💬 コミュニケーション: 18% (1h32m)
🔍 調査・リサーチ: 12% (1h2m)

🤖 AI自動化提案
⚡ Slackメッセージ返信 (47分/日)
   → Slack返信下書きBot で 32分削減可能
```
