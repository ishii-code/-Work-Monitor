import { createRequire } from 'module';
import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import { logToConsole } from './notifier.js';
import type { Category } from './types.js';

const require = createRequire(import.meta.url);
const axios = require('axios') as typeof import('axios').default;

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_BATCH_SIZE = 500;
const HTTP_TIMEOUT_MS = 15_000;

interface SyncableRow {
  id: number;
  app_name: string;
  window_title: string;
  category: Category;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  date: string;
}

interface CloudActivityPayload {
  app_name: string;
  window_title: string;
  category: Category;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  date: string;
}

function ensureSyncStateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function getLastSyncedId(db: Database.Database): number {
  ensureSyncStateTable(db);
  const row = db
    .prepare(`SELECT value FROM sync_state WHERE key = 'last_synced_activity_id'`)
    .get() as { value: string } | undefined;
  return row ? Number(row.value) || 0 : 0;
}

function setLastSyncedId(db: Database.Database, id: number): void {
  ensureSyncStateTable(db);
  db.prepare(
    `INSERT INTO sync_state (key, value) VALUES ('last_synced_activity_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(id));
}

function fetchPendingRows(db: Database.Database, sinceId: number, limit: number): SyncableRow[] {
  return db
    .prepare(
      `SELECT id, app_name, window_title, category, start_time, end_time, duration_seconds, date
       FROM activities
       WHERE id > ? AND end_time IS NOT NULL AND duration_seconds > 0
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(sinceId, limit) as SyncableRow[];
}

function toPayload(row: SyncableRow): CloudActivityPayload {
  return {
    app_name: row.app_name,
    window_title: (row.window_title ?? '').slice(0, 499),
    category: row.category,
    start_time: row.start_time,
    end_time: row.end_time,
    duration_seconds: row.duration_seconds,
    date: row.date,
  };
}

async function runOnce(): Promise<void> {
  const apiUrl = process.env.CLOUD_API_URL;
  const apiKey = process.env.EMPLOYEE_API_KEY;
  if (!apiUrl || !apiKey) return;

  const db = getDb();
  const lastId = getLastSyncedId(db);
  const rows = fetchPendingRows(db, lastId, SYNC_BATCH_SIZE);
  if (rows.length === 0) return;

  const payload = { activities: rows.map(toPayload) };
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/activities`;

  try {
    const res = await axios.post(endpoint, payload, {
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      const maxId = rows[rows.length - 1]!.id;
      setLastSyncedId(db, maxId);
      logToConsole(`☁️  cloud-sync: uploaded ${rows.length} activities (lastId=${maxId})`);
    } else {
      logToConsole(`☁️  cloud-sync: HTTP ${res.status} body=${JSON.stringify(res.data).slice(0,200)} — will retry next cycle`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logToConsole(`☁️  cloud-sync: network error — ${msg.slice(0, 120)}`);
  }
}

export function startCloudSync(): void {
  if (!process.env.CLOUD_API_URL || !process.env.EMPLOYEE_API_KEY) {
    logToConsole('☁️  cloud-sync disabled (CLOUD_API_URL / EMPLOYEE_API_KEY 未設定)');
    return;
  }
  logToConsole(`☁️  cloud-sync enabled: ${process.env.CLOUD_API_URL} (interval ${SYNC_INTERVAL_MS / 1000}s)`);

  setInterval(() => {
    runOnce().catch((e) => console.error('[cloud-sync]', e));
  }, SYNC_INTERVAL_MS);

  setTimeout(() => {
    runOnce().catch((e) => console.error('[cloud-sync]', e));
  }, 30_000);
}

export { runOnce as syncOnce };
