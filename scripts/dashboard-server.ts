import { loadEnv } from '../lib/load-env.js';
loadEnv();

import express from 'express';
import type { Request, Response } from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const axios = require('axios') as typeof import('axios').default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 3011);
const CLOUD_API_URL = process.env.CLOUD_API_URL ?? '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? '';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!CLOUD_API_URL || !ADMIN_API_KEY) {
  console.warn('[dashboard-server] CLOUD_API_URL または ADMIN_API_KEY が未設定です。.env を確認してください。');
}

const HTML_PATH = join(__dirname, 'admin-dashboard.html');
const HTML = readFileSync(HTML_PATH, 'utf-8');

const app = express();
app.disable('x-powered-by');

app.get('/', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

app.get('/api/monitor', async (req: Request, res: Response) => {
  if (!CLOUD_API_URL || !ADMIN_API_KEY) {
    res.status(500).json({ error: 'CLOUD_API_URL / ADMIN_API_KEY が未設定です' });
    return;
  }
  const dateParam = typeof req.query.date === 'string' ? req.query.date : '';
  const date = ISO_DATE_RE.test(dateParam) ? dateParam : new Date().toLocaleDateString('sv-SE');
  const endpoint = `${CLOUD_API_URL.replace(/\/$/, '')}/api/admin/monitor?date=${encodeURIComponent(date)}`;
  try {
    const upstream = await axios.get(endpoint, {
      headers: { 'X-API-Key': ADMIN_API_KEY },
      timeout: 15_000,
      validateStatus: () => true,
    });
    res.status(upstream.status).json(upstream.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'upstream error';
    res.status(502).json({ error: 'cloud API unreachable', detail: msg.slice(0, 200) });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pc-work-monitor-dashboard', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n📊 管理ダッシュボード: http://localhost:${PORT}`);
  console.log(`   upstream: ${CLOUD_API_URL || '(未設定)'}\n`);
});
