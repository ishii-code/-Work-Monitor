import pg from 'pg';
import type { Category } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export async function initCloudSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cloud_activities (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      app_name TEXT NOT NULL,
      window_title TEXT DEFAULT '',
      category TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration_seconds INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_activities_employee_date
      ON cloud_activities(employee_id, date);
    CREATE INDEX IF NOT EXISTS idx_cloud_activities_date
      ON cloud_activities(date);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_activities_dedupe
      ON cloud_activities(employee_id, app_name, start_time);
  `);
}

export interface Employee {
  id: number;
  api_key: string;
  name: string;
  email: string;
  created_at: string;
}

export async function getEmployeeByApiKey(apiKey: string): Promise<Employee | null> {
  const p = getPool();
  const result = await p.query<Employee>(
    'SELECT id, api_key, name, email, created_at FROM employees WHERE api_key = $1 LIMIT 1',
    [apiKey]
  );
  return result.rows[0] ?? null;
}

export interface CloudActivityInput {
  app_name: string;
  window_title: string;
  category: Category;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  date: string;
}

export async function insertActivities(
  employeeId: number,
  activities: CloudActivityInput[]
): Promise<number> {
  if (activities.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const a of activities) {
      const r = await client.query(
        `INSERT INTO cloud_activities
          (employee_id, app_name, window_title, category, start_time, end_time, duration_seconds, date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (employee_id, app_name, start_time) DO UPDATE SET
           end_time = EXCLUDED.end_time,
           duration_seconds = EXCLUDED.duration_seconds,
           window_title = EXCLUDED.window_title,
           category = EXCLUDED.category
         RETURNING id`,
        [
          employeeId,
          a.app_name.slice(0, 255),
          (a.window_title ?? '').slice(0, 500),
          a.category,
          a.start_time,
          a.end_time,
          Math.max(0, Math.min(86_400, a.duration_seconds | 0)),
          a.date,
        ]
      );
      if (r.rowCount && r.rowCount > 0) inserted += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return inserted;
}

export interface EmployeeDailyStat {
  employee_id: number;
  name: string;
  email: string;
  total_seconds: number;
  idle_seconds: number;
  last_seen: string | null;
  categories: Array<{ category: string; total_seconds: number }>;
  top_apps: Array<{ app_name: string; total_seconds: number }>;
}

export async function getMonitorOverview(date: string): Promise<EmployeeDailyStat[]> {
  const p = getPool();
  const categoryRows = await p.query<{
    employee_id: number;
    name: string;
    email: string;
    category: string | null;
    total_seconds: string;
    last_seen: string | null;
  }>(
    `SELECT e.id AS employee_id, e.name, e.email,
            a.category,
            COALESCE(SUM(a.duration_seconds), 0)::text AS total_seconds,
            MAX(a.end_time) AS last_seen
     FROM employees e
     LEFT JOIN cloud_activities a
       ON a.employee_id = e.id AND a.date = $1
     GROUP BY e.id, e.name, e.email, a.category
     ORDER BY e.name ASC`,
    [date]
  );

  const appRows = await p.query<{
    employee_id: number;
    app_name: string;
    total_seconds: string;
  }>(
    `SELECT employee_id, app_name,
            COALESCE(SUM(duration_seconds), 0)::text AS total_seconds
     FROM cloud_activities
     WHERE date = $1 AND category <> 'idle'
     GROUP BY employee_id, app_name
     ORDER BY employee_id, SUM(duration_seconds) DESC`,
    [date]
  );

  const map = new Map<number, EmployeeDailyStat>();
  for (const row of categoryRows.rows) {
    const seconds = Number(row.total_seconds) || 0;
    let entry = map.get(row.employee_id);
    if (!entry) {
      entry = {
        employee_id: row.employee_id,
        name: row.name,
        email: row.email,
        total_seconds: 0,
        idle_seconds: 0,
        last_seen: null,
        categories: [],
        top_apps: [],
      };
      map.set(row.employee_id, entry);
    }
    if (row.category === 'idle') {
      entry.idle_seconds += seconds;
    } else if (row.category) {
      entry.total_seconds += seconds;
      entry.categories.push({ category: row.category, total_seconds: seconds });
    }
    if (row.last_seen && (!entry.last_seen || row.last_seen > entry.last_seen)) {
      entry.last_seen = row.last_seen;
    }
  }

  for (const row of appRows.rows) {
    const entry = map.get(row.employee_id);
    if (!entry) continue;
    if (entry.top_apps.length >= 5) continue;
    entry.top_apps.push({
      app_name: row.app_name,
      total_seconds: Number(row.total_seconds) || 0,
    });
  }

  for (const entry of map.values()) {
    entry.categories.sort((a, b) => b.total_seconds - a.total_seconds);
  }

  return Array.from(map.values());
}
