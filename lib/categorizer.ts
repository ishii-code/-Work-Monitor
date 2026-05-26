import type { Category } from './types.js';

interface Rule {
  category: Category;
  appPatterns?: RegExp[];
  urlPatterns?: RegExp[];
  titlePatterns?: RegExp[];
}

const RULES: Rule[] = [
  // 開発系
  {
    category: 'core_dev',
    appPatterns: [/^(Code|Cursor|VSCode|Visual Studio Code|WebStorm|IntelliJ|Xcode|Zed|Nova)$/i],
  },
  {
    category: 'core_dev',
    appPatterns: [/^(iTerm|iTerm2|Terminal|Warp|Hyper|Alacritty|kitty|Ghostty)$/i],
  },
  {
    category: 'core_dev',
    appPatterns: [/^(Claude|Claude Code)$/i],
    titlePatterns: [/claude code/i],
  },
  {
    category: 'core_dev',
    urlPatterns: [/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)/],
  },
  // AI ツール
  {
    category: 'ai_tool',
    urlPatterns: [/^https?:\/\/(claude\.ai|chat\.openai\.com|chatgpt\.com|gemini\.google\.com|copilot\.microsoft\.com)/],
  },
  // コミュニケーション
  {
    category: 'communication',
    appPatterns: [/^Slack$/i],
  },
  {
    category: 'communication',
    appPatterns: [/^(Mail|Microsoft Outlook|Spark|Airmail|Mimestream)$/i],
  },
  {
    category: 'communication',
    urlPatterns: [/^https?:\/\/(mail\.google\.com|outlook\.live\.com|outlook\.office\.com)/],
  },
  // ミーティング
  {
    category: 'meeting',
    appPatterns: [/^(zoom\.us|Zoom|Microsoft Teams|Google Meet|Webex|Around|Discord)$/i],
  },
  {
    category: 'meeting',
    urlPatterns: [/^https?:\/\/(meet\.google\.com|teams\.microsoft\.com|zoom\.us\/j)/],
  },
  // デザイン
  {
    category: 'design',
    appPatterns: [/^(Figma|Sketch|Adobe|Canva|Affinity)$/i],
  },
  {
    category: 'design',
    urlPatterns: [/^https?:\/\/(www\.figma\.com|canva\.com)/],
  },
  // ドキュメント / リサーチ
  {
    category: 'research',
    urlPatterns: [/^https?:\/\/(www\.notion\.so|notion\.so|docs\.google\.com|drive\.google\.com)/],
  },
  {
    category: 'research',
    urlPatterns: [/^https?:\/\/(qiita\.com|zenn\.dev|dev\.to|medium\.com|speakerdeck\.com)/],
  },
  {
    category: 'research',
    urlPatterns: [/^https?:\/\/(www\.youtube\.com|youtube\.com)/],
  },
  // 管理系
  {
    category: 'admin',
    appPatterns: [/^Finder$/i],
  },
  {
    category: 'admin',
    appPatterns: [/^(System Preferences|System Settings|Activity Monitor|Disk Utility)$/i],
  },
];

export function categorize(appName: string, windowTitle: string, url: string): Category {
  for (const rule of RULES) {
    if (rule.appPatterns?.some(p => p.test(appName))) return rule.category;
    if (url && rule.urlPatterns?.some(p => p.test(url))) return rule.category;
    if (windowTitle && rule.titlePatterns?.some(p => p.test(windowTitle))) return rule.category;
  }

  // ブラウザはURLがなければresearchとしてフォールバック
  if (/^(Google Chrome|Safari|Firefox|Arc|Brave|Edge)$/i.test(appName)) {
    return 'research';
  }

  return 'other';
}

export const CATEGORY_LABELS: Record<Category, string> = {
  core_dev: '⚙️  コア開発',
  communication: '💬 コミュニケーション',
  meeting: '📹 ミーティング',
  research: '🔍 調査・リサーチ',
  admin: '🗂  管理・事務',
  design: '🎨 デザイン',
  ai_tool: '🤖 AIツール',
  entertainment: '🎮 エンタメ',
  idle: '😴 アイドル',
  other: '❓ その他',
};

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
