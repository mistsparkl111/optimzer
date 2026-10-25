import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, type UserRow } from './db';
import { isProd } from './env';
import { randomToken, sha256 } from './crypto';
import { DAY, fail } from './util';

export type AppEnv = { Variables: { user: UserRow | null } };

const COOKIE = 'radar_sid';
const SESSION_DAYS = 60;

export function createSession(c: Context, userId: number) {
  const token = randomToken();
  const t = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    t,
    t + SESSION_DAYS * DAY,
    (c.req.header('user-agent') || '').slice(0, 200),
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProd,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export function destroySession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  deleteCookie(c, COOKIE, { path: '/' });
}

export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  let user: UserRow | null = null;
  if (token) {
    user =
      (db
        .prepare(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`,
        )
        .get(sha256(token), Date.now()) as UserRow | undefined) || null;
    if (user?.banned) user = null;
  }
  c.set('user', user);
  await next();
};

export function requireUser(c: Context<AppEnv>): UserRow {
  const u = c.get('user');
  if (!u) fail(401, 'Требуется вход в аккаунт');
  return u;
}

export function requireRole(...roles: UserRow['role'][]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const u = requireUser(c);
    if (!roles.includes(u.role)) fail(403, 'Недостаточно прав');
    await next();
  };
}

/** CSRF guard: reject cross-site state-changing requests. */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !c.req.path.includes('/webhook/')) {
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') || c.req.header('host');
    if (origin && host) {
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) fail(403, 'Запрос с чужого источника отклонён');
    }
  }
  await next();
};

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), DAY).unref();
