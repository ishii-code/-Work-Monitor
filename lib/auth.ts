import { hash as bcryptHash, compare as bcryptCompare } from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response, NextFunction, Router as RouterType } from 'express';
import { Router } from 'express';
import { randomBytes } from 'crypto';
import {
  getPool,
  getMonitorOverview,
  type Employee,
} from './cloud-db.js';

export const SESSION_COOKIE = 'wm_session';
const SESSION_TTL_HOURS = 12;

export type Role = 'ADMIN' | 'USER';

export interface WmUser {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  must_change_password: boolean;
  employee_id: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionPayload {
  sub: number;
  email: string;
  role: Role;
}

interface AuthedRequest extends Request {
  user?: WmUser;
}

function authSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_SECRET must be set (min 16 chars)');
  }
  return new TextEncoder().encode(s);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcryptHash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcryptCompare(plain, hash);
}

export function generateTempPassword(): string {
  return randomBytes(12).toString('base64url');
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(payload.sub))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_HOURS}h`)
    .sign(authSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret());
    const sub = Number(payload.sub);
    if (!Number.isFinite(sub)) return null;
    return {
      sub,
      email: String(payload.email ?? ''),
      role: (payload.role === 'ADMIN' ? 'ADMIN' : 'USER') as Role,
    };
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionToken(req: Request): string | null {
  const cookies = parseCookies(req.header('cookie'));
  return cookies[SESSION_COOKIE] ?? null;
}

export function setSessionCookie(res: Response, token: string): void {
  const maxAge = SESSION_TTL_HOURS * 3600;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

export async function getUserById(id: number): Promise<WmUser | null> {
  const p = getPool();
  const r = await p.query<WmUser>(
    `SELECT id, email, name, password_hash, role, must_change_password,
            employee_id, last_login_at, created_at, updated_at
     FROM wm_users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rows[0] ?? null;
}

export async function getUserByEmail(email: string): Promise<WmUser | null> {
  const p = getPool();
  const r = await p.query<WmUser>(
    `SELECT id, email, name, password_hash, role, must_change_password,
            employee_id, last_login_at, created_at, updated_at
     FROM wm_users WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  return r.rows[0] ?? null;
}

export async function listUsers(): Promise<WmUser[]> {
  const p = getPool();
  const r = await p.query<WmUser>(
    `SELECT id, email, name, password_hash, role, must_change_password,
            employee_id, last_login_at, created_at, updated_at
     FROM wm_users ORDER BY created_at DESC`
  );
  return r.rows;
}

export async function createUser(args: {
  email: string;
  name: string;
  password: string;
  role: Role;
  mustChangePassword: boolean;
  employeeId?: number | null;
}): Promise<WmUser> {
  const hash = await hashPassword(args.password);
  const p = getPool();
  const r = await p.query<WmUser>(
    `INSERT INTO wm_users (email, name, password_hash, role, must_change_password, employee_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, name, password_hash, role, must_change_password,
               employee_id, last_login_at, created_at, updated_at`,
    [args.email.toLowerCase(), args.name, hash, args.role, args.mustChangePassword, args.employeeId ?? null]
  );
  return r.rows[0]!;
}

export async function deleteUser(id: number): Promise<boolean> {
  const p = getPool();
  const r = await p.query('DELETE FROM wm_users WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function updateUserPassword(id: number, password: string, mustChange: boolean): Promise<void> {
  const hash = await hashPassword(password);
  const p = getPool();
  await p.query(
    `UPDATE wm_users SET password_hash = $1, must_change_password = $2, updated_at = NOW() WHERE id = $3`,
    [hash, mustChange, id]
  );
}

export async function touchLastLogin(id: number): Promise<void> {
  const p = getPool();
  await p.query(`UPDATE wm_users SET last_login_at = NOW() WHERE id = $1`, [id]);
}

export async function ensureDefaultAdmin(): Promise<void> {
  const email = 'takeshi.ishii@peco-japan.com';
  const existing = await getUserByEmail(email);
  if (existing) return;
  await createUser({
    email,
    name: '石井 豪',
    password: 'WmAdmin2026!',
    role: 'ADMIN',
    mustChangePassword: true,
  });
  console.log(`[auth] default admin created: ${email} (temp password: WmAdmin2026!)`);
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = getSessionToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const session = await verifySession(token);
  if (!session) {
    res.status(401).json({ error: 'invalid session' });
    return;
  }
  const user = await getUserById(session.sub);
  if (!user) {
    clearSessionCookie(res);
    res.status(401).json({ error: 'user not found' });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ error: 'admin only' });
    return;
  }
  next();
}

function publicUser(u: WmUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    must_change_password: u.must_change_password,
    employee_id: u.employee_id,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  };
}

export function createAuthRouter(): RouterType {
  const router = Router();

  router.post('/api/auth/login', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 200 || password.length > 200) {
      res.status(400).json({ error: 'email と password が必須です' });
      return;
    }
    const user = await getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    await touchLastLogin(user.id);
    const token = await signSession({ sub: user.id, email: user.email, role: user.role });
    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  });

  router.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
    res.json({ user: publicUser(req.user!) });
  });

  router.post('/api/auth/change-password', requireAuth, async (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!current || !next || next.length < 8 || next.length > 200) {
      res.status(400).json({ error: '新パスワードは 8〜200 文字必須です' });
      return;
    }
    const ok = await verifyPassword(current, req.user!.password_hash);
    if (!ok) {
      res.status(401).json({ error: '現在のパスワードが違います' });
      return;
    }
    await updateUserPassword(req.user!.id, next, false);
    res.json({ ok: true });
  });

  return router;
}

export function createUserAdminRouter(): RouterType {
  const router = Router();

  router.get('/api/admin/users', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const users = await listUsers();
    res.json({ users: users.map(publicUser) });
  });

  router.post('/api/admin/users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        email?: unknown; name?: unknown; role?: unknown; employeeId?: unknown;
      };
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const role: Role = body.role === 'ADMIN' ? 'ADMIN' : 'USER';
      const employeeId = typeof body.employeeId === 'number' && Number.isFinite(body.employeeId) ? body.employeeId : null;
      if (!email || !name || email.length > 200 || name.length > 100) {
        res.status(400).json({ error: 'email と name が必須です' });
        return;
      }
      const existing = await getUserByEmail(email);
      if (existing) {
        res.status(409).json({ error: 'このメールは既に登録されています' });
        return;
      }
      const tempPassword = generateTempPassword();
      const user = await createUser({
        email, name, password: tempPassword, role, mustChangePassword: true, employeeId,
      });
      res.json({ ok: true, user: publicUser(user), tempPassword });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[POST /api/admin/users] failed:', msg);
      res.status(500).json({ error: 'user 作成失敗: ' + msg.slice(0, 200) });
    }
  });

  router.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    if (req.user!.id === id) {
      res.status(400).json({ error: '自分自身は削除できません' });
      return;
    }
    const ok = await deleteUser(id);
    if (!ok) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    const tempPassword = generateTempPassword();
    await updateUserPassword(id, tempPassword, true);
    res.json({ ok: true, tempPassword });
  });

  return router;
}

export function createMonitorRouter(): RouterType {
  const router = Router();

  router.get('/api/monitor', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const dateParam = typeof req.query.date === 'string' ? req.query.date : '';
    const date = ISO_DATE_RE.test(dateParam) ? dateParam : new Date().toLocaleDateString('sv-SE');
    try {
      const overview = await getMonitorOverview(date);
      if (req.user!.role === 'ADMIN') {
        res.json({ date, employees: overview, role: 'ADMIN' });
        return;
      }
      const own = overview.filter((e) => e.employee_id === req.user!.employee_id);
      res.json({ date, employees: own, role: 'USER' });
    } catch {
      res.status(500).json({ error: 'failed to load overview' });
    }
  });

  return router;
}

export type { Employee };
