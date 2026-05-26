import { loadEnv } from './load-env.js';
loadEnv();

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  initCloudSchema,
  getEmployeeByApiKey,
  insertActivities,
  getMonitorOverview,
  type CloudActivityInput,
  type Employee,
} from './cloud-db.js';
import type { Category } from './types.js';

const ALLOWED_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  'core_dev',
  'communication',
  'meeting',
  'research',
  'admin',
  'design',
  'ai_tool',
  'entertainment',
  'idle',
  'other',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACTIVITIES_PER_REQUEST = 1000;

interface AuthedRequest extends Request {
  employee?: Employee;
}

async function requireApiKey(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey.length < 16 || apiKey.length > 256) {
    res.status(401).json({ error: 'missing or invalid x-api-key' });
    return;
  }
  try {
    const employee = await getEmployeeByApiKey(apiKey);
    if (!employee) {
      res.status(401).json({ error: 'unknown api key' });
      return;
    }
    req.employee = employee;
    next();
  } catch {
    res.status(500).json({ error: 'auth failure' });
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_API_KEY;
  const provided = req.header('x-api-key');
  if (!adminKey || !provided || provided !== adminKey) {
    res.status(401).json({ error: 'admin authentication required' });
    return;
  }
  next();
}

function isIsoTimestamp(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 20 || s.length > 40) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function validateActivity(raw: unknown): CloudActivityInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const appName = typeof o.app_name === 'string' ? o.app_name.trim() : '';
  if (!appName || appName.length > 255) return null;

  const windowTitle = typeof o.window_title === 'string' ? o.window_title : '';
  if (windowTitle.length > 500) return null;

  const category = typeof o.category === 'string' ? (o.category as Category) : null;
  if (!category || !ALLOWED_CATEGORIES.has(category)) return null;

  if (!isIsoTimestamp(o.start_time)) return null;
  const endTime = o.end_time == null ? null : (isIsoTimestamp(o.end_time) ? (o.end_time as string) : null);
  if (o.end_time != null && endTime === null) return null;

  const duration = Number(o.duration_seconds);
  if (!Number.isFinite(duration) || duration < 0 || duration > 86_400) return null;

  const date = typeof o.date === 'string' ? o.date : '';
  if (!ISO_DATE_RE.test(date)) return null;

  return {
    app_name: appName,
    window_title: windowTitle,
    category,
    start_time: o.start_time as string,
    end_time: endTime,
    duration_seconds: Math.floor(duration),
    date,
  };
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pc-work-monitor-cloud', time: new Date().toISOString() });
  });

  app.post('/api/activities', requireApiKey, async (req: AuthedRequest, res: Response) => {
    const employee = req.employee;
    if (!employee) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const body = req.body as { activities?: unknown };
    if (!body || !Array.isArray(body.activities)) {
      res.status(400).json({ error: 'activities[] is required' });
      return;
    }
    if (body.activities.length === 0) {
      res.json({ ok: true, accepted: 0 });
      return;
    }
    if (body.activities.length > MAX_ACTIVITIES_PER_REQUEST) {
      res.status(400).json({ error: `too many activities (max ${MAX_ACTIVITIES_PER_REQUEST})` });
      return;
    }

    const validated: CloudActivityInput[] = [];
    for (const raw of body.activities) {
      const v = validateActivity(raw);
      if (!v) {
        res.status(400).json({ error: 'invalid activity payload' });
        return;
      }
      validated.push(v);
    }

    try {
      const accepted = await insertActivities(employee.id, validated);
      res.json({ ok: true, accepted });
    } catch {
      res.status(500).json({ error: 'failed to persist activities' });
    }
  });

  app.get('/api/admin/monitor', requireAdmin, async (req: Request, res: Response) => {
    const dateParam = typeof req.query.date === 'string' ? req.query.date : '';
    const date = ISO_DATE_RE.test(dateParam) ? dateParam : new Date().toLocaleDateString('sv-SE');
    try {
      const overview = await getMonitorOverview(date);
      res.json({ date, employees: overview });
    } catch {
      res.status(500).json({ error: 'failed to load overview' });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  await initCloudSchema();
  const app = createApp();
  app.listen(port, () => {
    console.log(`[server] pc-work-monitor cloud API listening on :${port}`);
  });
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error('[server] fatal:', e);
    process.exit(1);
  });
}
