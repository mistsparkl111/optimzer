import { Hono } from 'hono';
import { z } from 'zod';
import { createSession, destroySession, requireUser, type AppEnv } from '../auth';
import { db } from '../db';
import { hashPassword, verifyPassword } from '../crypto';
import { body, clientIp, fail, rateLimit } from '../util';
import { getUser, getUserByEmail, toPublicUser } from '../users';
import { isRegionId } from '../../shared/regions';

export const authRoutes = new Hono<AppEnv>();

const registerSchema = z.object({
  email: z.email('Некорректный email').max(120),
  password: z.string().min(8, 'Пароль — минимум 8 символов').max(200),
  name: z.string().trim().min(2, 'Имя — минимум 2 символа').max(40),
  regionId: z.string().nullable().optional(),
  extraRegions: z.array(z.string()).max(4).optional(),
});

authRoutes.post('/register', async (c) => {
  if (!rateLimit(`reg:${clientIp(c)}`, 5, 3_600_000)) fail(429, 'Слишком много регистраций, попробуйте позже');
  const data = await body(c, registerSchema);
  const email = data.email.trim().toLowerCase();
  if (getUserByEmail(email)) fail(409, 'Этот email уже зарегистрирован');
  const regionId = data.regionId && isRegionId(data.regionId) ? data.regionId : null;
  const extra = (data.extraRegions || []).filter(isRegionId).filter((r) => r !== regionId);
  const info = db
    .prepare(
      'INSERT INTO users (email, name, password_hash, region_id, extra_regions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(email, data.name, hashPassword(data.password), regionId, JSON.stringify(extra), Date.now());
  const id = Number(info.lastInsertRowid);
  createSession(c, id);
  return c.json({ user: toPublicUser(getUser(id)!) });
});

const loginSchema = z.object({ email: z.string().trim().max(120), password: z.string().max(200) });

authRoutes.post('/login', async (c) => {
  const data = await body(c, loginSchema);
  const ip = clientIp(c);
  if (!rateLimit(`login:${ip}`, 20, 15 * 60_000) || !rateLimit(`login:${data.email.toLowerCase()}`, 10, 15 * 60_000))
    fail(429, 'Слишком много попыток входа, подождите 15 минут');
  const u = getUserByEmail(data.email);
  if (!u || !verifyPassword(data.password, u.password_hash)) fail(401, 'Неверный email или пароль');
  if (u.banned) fail(403, 'Аккаунт заблокирован');
  createSession(c, u.id);
  return c.json({ user: toPublicUser(u) });
});

authRoutes.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', (c) => {
  const u = c.get('user');
  return c.json({ user: u ? toPublicUser(u) : null });
});

authRoutes.post('/password', async (c) => {
  const u = requireUser(c);
  const data = await body(c, z.object({ current: z.string(), next: z.string().min(8, 'Пароль — минимум 8 символов').max(200) }));
  if (!verifyPassword(data.current, u.password_hash)) fail(400, 'Текущий пароль неверен');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(data.next), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  createSession(c, u.id);
  return c.json({ ok: true });
});
