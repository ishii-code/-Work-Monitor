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

    CREATE TABLE IF NOT EXISTS wm_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER',
      must_change_password BOOLEAN NOT NULL DEFAULT true,
      employee_id INTEGER REFERENCES employees(id),
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wm_users_email ON wm_users(lower(email));

    CREATE TABLE IF NOT EXISTS monitoring_logs (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES employees(id),
      action TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_monitoring_logs_employee_created
      ON monitoring_logs(employee_id, created_at DESC);
  `);
}

export type MonitoringAction = 'start' | 'stop';

export async function recordMonitoringLog(employeeId: number, action: MonitoringAction, reason: string | null): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO monitoring_logs (employee_id, action, reason) VALUES ($1, $2, $3)`,
    [employeeId, action, reason ? reason.slice(0, 500) : null]
  );
}

export async function getLatestMonitoringStatus(employeeId: number): Promise<MonitoringAction | null> {
  const p = getPool();
  const r = await p.query<{ action: string }>(
    `SELECT action FROM monitoring_logs WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [employeeId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0]!.action === 'stop' ? 'stop' : 'start';
}

export async function listMonitoringLogs(limit = 200): Promise<Array<{
  id: number;
  employee_id: number;
  employee_name: string;
  action: string;
  reason: string | null;
  created_at: string;
}>> {
  const p = getPool();
  const r = await p.query<{
    id: number;
    employee_id: number;
    employee_name: string;
    action: string;
    reason: string | null;
    created_at: string;
  }>(
    `SELECT m.id, m.employee_id, COALESCE(e.name, '(未紐づけ)') AS employee_name,
            m.action, m.reason, m.created_at
     FROM monitoring_logs m
     LEFT JOIN employees e ON e.id = m.employee_id
     ORDER BY m.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
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

export interface CloudDailySummary {
  date: string;
  total_tracked_seconds: number;
  idle_seconds: number;
  categories: Array<{
    category: string;
    total_seconds: number;
    apps: Array<{ app_name: string; total_seconds: number; window_titles: string[] }>;
  }>;
  top_apps: Array<{ app_name: string; total_seconds: number; window_titles: string[] }>;
}

export async function getDailySummaryFromCloud(
  employeeId: number,
  date: string
): Promise<CloudDailySummary> {
  const p = getPool();
  const rows = await p.query<{
    category: string;
    app_name: string;
    total_seconds: string;
  }>(
    `SELECT category, app_name,
            COALESCE(SUM(duration_seconds), 0)::text AS total_seconds
     FROM cloud_activities
     WHERE employee_id = $1 AND date = $2
     GROUP BY category, app_name
     ORDER BY SUM(duration_seconds) DESC`,
    [employeeId, date]
  );

  let idleSeconds = 0;
  const catMap = new Map<string, {
    category: string;
    total_seconds: number;
    apps: Array<{ app_name: string; total_seconds: number; window_titles: string[] }>;
  }>();
  const appMap = new Map<string, { app_name: string; total_seconds: number; window_titles: string[] }>();

  for (const row of rows.rows) {
    const secs = Number(row.total_seconds) || 0;
    if (row.category === 'idle') {
      idleSeconds += secs;
      continue;
    }
    let cat = catMap.get(row.category);
    if (!cat) {
      cat = { category: row.category, total_seconds: 0, apps: [] };
      catMap.set(row.category, cat);
    }
    cat.total_seconds += secs;
    cat.apps.push({ app_name: row.app_name, total_seconds: secs, window_titles: [] });

    const existing = appMap.get(row.app_name);
    if (existing) {
      existing.total_seconds += secs;
    } else {
      appMap.set(row.app_name, { app_name: row.app_name, total_seconds: secs, window_titles: [] });
    }
  }

  const categories = Array.from(catMap.values()).sort((a, b) => b.total_seconds - a.total_seconds);
  const total = categories.reduce((sum, c) => sum + c.total_seconds, 0);
  const top_apps = Array.from(appMap.values())
    .sort((a, b) => b.total_seconds - a.total_seconds)
    .slice(0, 10);

  return {
    date,
    total_tracked_seconds: total,
    idle_seconds: idleSeconds,
    categories,
    top_apps,
  };
}

export interface OnboardingStep {
  userId: number;
  name: string;
  email: string;
  steps: {
    account_created: boolean;
    employee_registered: boolean;
    employee_linked: boolean;
    daemon_installed: boolean;
  };
  current_turn: 'admin' | 'user' | 'complete';
  last_activity: string | null;
}

function deriveTurn(s: OnboardingStep['steps']): OnboardingStep['current_turn'] {
  if (!s.account_created) return 'admin';
  if (!s.employee_registered) return 'admin';
  if (!s.employee_linked) return 'admin';
  if (!s.daemon_installed) return 'user';
  return 'complete';
}

export async function listAllEmployees(): Promise<Array<{ id: number; name: string; email: string }>> {
  const p = getPool();
  const r = await p.query<{ id: number; name: string; email: string }>(
    `SELECT id, name, email FROM employees ORDER BY name ASC`
  );
  return r.rows;
}

export async function linkUserEmployee(userId: number, employeeId: number | null): Promise<boolean> {
  const p = getPool();
  const r = await p.query(
    `UPDATE wm_users SET employee_id = $1, updated_at = NOW() WHERE id = $2`,
    [employeeId, userId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function findEmployeeByEmail(email: string): Promise<{ id: number; name: string; email: string } | null> {
  const p = getPool();
  const r = await p.query<{ id: number; name: string; email: string }>(
    `SELECT id, name, email FROM employees WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  return r.rows[0] ?? null;
}

export async function hasAnyActivities(employeeId: number): Promise<boolean> {
  const p = getPool();
  const r = await p.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM cloud_activities WHERE employee_id = $1) AS exists`,
    [employeeId]
  );
  return !!r.rows[0]?.exists;
}

export async function getOnboardingStatus(userId?: number): Promise<OnboardingStep[]> {
  const p = getPool();
  const filter = userId ? 'WHERE u.id = $1' : '';
  const params = userId ? [userId] : [];
  const r = await p.query<{
    user_id: number;
    name: string;
    email: string;
    employee_id: number | null;
    employee_registered: boolean;
    last_activity: string | null;
  }>(
    `SELECT
       u.id AS user_id,
       u.name,
       u.email,
       u.employee_id,
       CASE WHEN e.id IS NOT NULL THEN true ELSE false END AS employee_registered,
       (SELECT MAX(date) FROM cloud_activities
          WHERE employee_id = u.employee_id) AS last_activity
     FROM wm_users u
     LEFT JOIN employees e ON lower(e.email) = lower(u.email)
     ${filter}
     ORDER BY u.created_at ASC`,
    params
  );
  return r.rows.map((row) => {
    const steps = {
      account_created: true,
      employee_registered: !!row.employee_registered,
      employee_linked: row.employee_id !== null,
      daemon_installed: row.last_activity !== null,
    };
    return {
      userId: row.user_id,
      name: row.name,
      email: row.email,
      steps,
      current_turn: deriveTurn(steps),
      last_activity: row.last_activity,
    };
  });
}

export async function getWeeklySummaryFromCloud(
  employeeId: number
): Promise<CloudDailySummary[]> {
  const days: CloudDailySummary[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toLocaleDateString('sv-SE');
    days.push(await getDailySummaryFromCloud(employeeId, date));
  }
  return days;
}
