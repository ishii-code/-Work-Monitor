import Database from 'better-sqlite3';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ActivityRecord, AIInsight, DailySummary, CategorySummary, AppSummary, Category } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/work-monitor.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new BetterSqlite3(DB_PATH);
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      window_title TEXT DEFAULT '',
      url TEXT DEFAULT '',
      category TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration_seconds INTEGER DEFAULT 0,
      date TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);
    CREATE INDEX IF NOT EXISTS idx_activities_category ON activities(category);

    CREATE TABLE IF NOT EXISTS ai_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      report_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insights_date ON ai_insights(date);
  `);
}

export function upsertActivity(record: Omit<ActivityRecord, 'id'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO activities (app_name, window_title, url, category, start_time, end_time, duration_seconds, date)
    VALUES (@app_name, @window_title, @url, @category, @start_time, @end_time, @duration_seconds, @date)
  `);
  const result = stmt.run(record);
  return result.lastInsertRowid as number;
}

export function updateActivityEnd(id: number, end_time: string, duration_seconds: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE activities SET end_time = ?, duration_seconds = ? WHERE id = ?
  `).run(end_time, duration_seconds, id);
}

export function getTodayActivities(date: string): ActivityRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM activities WHERE date = ? ORDER BY start_time ASC
  `).all(date) as ActivityRecord[];
}

export function getDailySummary(date: string): DailySummary {
  const db = getDb();

  const rows = db.prepare(`
    SELECT category, app_name, window_title, SUM(duration_seconds) as total_seconds
    FROM activities
    WHERE date = ? AND category != 'idle'
    GROUP BY category, app_name
    ORDER BY total_seconds DESC
  `).all(date) as Array<{ category: Category; app_name: string; window_title: string; total_seconds: number }>;

  const idleRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as idle_seconds
    FROM activities WHERE date = ? AND category = 'idle'
  `).get(date) as { idle_seconds: number };

  const categoryMap = new Map<Category, CategorySummary>();

  for (const row of rows) {
    if (!categoryMap.has(row.category)) {
      categoryMap.set(row.category, { category: row.category, total_seconds: 0, apps: [] });
    }
    const cat = categoryMap.get(row.category)!;
    cat.total_seconds += row.total_seconds;

    const existing = cat.apps.find(a => a.app_name === row.app_name);
    if (existing) {
      existing.total_seconds += row.total_seconds;
      if (row.window_title && !existing.window_titles.includes(row.window_title)) {
        existing.window_titles.push(row.window_title);
      }
    } else {
      cat.apps.push({
        app_name: row.app_name,
        total_seconds: row.total_seconds,
        window_titles: row.window_title ? [row.window_title] : [],
      });
    }
  }

  const categories = Array.from(categoryMap.values()).sort((a, b) => b.total_seconds - a.total_seconds);
  const total = categories.reduce((sum, c) => sum + c.total_seconds, 0);

  const topApps: AppSummary[] = [];
  for (const cat of categories) {
    for (const app of cat.apps) {
      topApps.push(app);
    }
  }
  topApps.sort((a, b) => b.total_seconds - a.total_seconds);

  return {
    date,
    total_tracked_seconds: total,
    idle_seconds: idleRow.idle_seconds,
    categories,
    top_apps: topApps.slice(0, 10),
  };
}

export function saveInsight(insight: Omit<AIInsight, 'id'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ai_insights (date, report_type, content, created_at)
    VALUES (?, ?, ?, ?)
  `).run(insight.date, insight.report_type, JSON.stringify(insight), insight.created_at);
}

export function getLastInsight(date: string): AIInsight | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT content FROM ai_insights WHERE date = ? ORDER BY created_at DESC LIMIT 1
  `).get(date) as { content: string } | undefined;
  return row ? JSON.parse(row.content) as AIInsight : null;
}

export function deleteDayActivities(date: string): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM activities WHERE date = ?').run(date);
  return result.changes as number;
}
