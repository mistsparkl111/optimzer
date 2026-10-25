import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth';
import { db } from '../db';
import { body, clientIp, fail, rateLimit } from '../util';
import { sendTest } from '../services/push';
import { getUser, userSettings } from '../users';
import { ALERT_TYPES, MAX_EXTRA_REGIONS, REPORT_TYPES } from '../../shared/constants';
import { isRegionId } from '../../shared/regions';

export const pushRoutes = new Hono<AppEnv>();

const threat = z.enum([...new Set([...ALERT_TYPES, ...REPORT_TYPES])] as [string, ...string[]]);
const subSchema = z.object({
  subscription: z.object({
    endpoint: z.url().max(1000),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  }),
  deviceId: z.string().max(64).optional(),
  regions: z.array(z.string()).max(MAX_EXTRA_REGIONS + 1),
  prefs: z
    .object({
      enabled: z.boolean(),
      official: z.boolean(),
      userReports: z.boolean(),
      allClear: z.boolean(),
      types: z.array(threat),
    })
    .partial()
    .optional(),
});

pushRoutes.post('/subscribe', async (c) => {
  if (!rateLimit(`sub:${clientIp(c)}`, 30, 3_600_000)) fail(429, 'Слишком много запросов');
  const data = await body(c, subSchema);
  const user = c.get('user');
  let regions = data.regions.filter(isRegionId);
  let prefs = data.prefs || {};
  if (user) {
    // Logged-in users: the account is the source of truth.
    const u = getUser(user.id)!;
    const acc = [u.region_id, ...JSON.parse(u.extra_regions || '[]')].filter(Boolean) as string[];
    if (acc.length) regions = acc;
    prefs = userSettings(u).notify;
  }
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id, device_id, regions, prefs, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
       user_id = COALESCE(excluded.user_id, push_subscriptions.user_id), device_id = excluded.device_id,
       regions = excluded.regions, prefs = excluded.prefs, fail_count = 0`,
  ).run(
    data.subscription.endpoint,
    data.subscription.keys.p256dh,
    data.subscription.keys.auth,
    user?.id ?? null,
    data.deviceId ?? null,
    JSON.stringify(regions),
    JSON.stringify(prefs),
    Date.now(),
  );
  return c.json({ ok: true, regions });
});

pushRoutes.post('/unsubscribe', async (c) => {
  const { endpoint } = await body(c, z.object({ endpoint: z.string().max(1000) }));
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return c.json({ ok: true });
});

pushRoutes.post('/test', async (c) => {
  const { endpoint } = await body(c, z.object({ endpoint: z.string().max(1000) }));
  if (!rateLimit(`pushtest:${endpoint}`, 3, 10 * 60_000)) fail(429, 'Тест можно запускать не чаще 3 раз за 10 минут');
  const ok = await sendTest(endpoint);
  if (!ok) fail(404, 'Подписка не найдена — включите уведомления заново');
  return c.json({ ok });
});
