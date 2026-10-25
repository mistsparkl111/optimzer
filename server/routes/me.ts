import { Hono } from 'hono';
import { z } from 'zod';
import { destroySession, requireUser, type AppEnv } from '../auth';
import { db } from '../db';
import { verifyPassword } from '../crypto';
import { body, fail } from '../util';
import { getUser, toPublicUser, userSettings } from '../users';
import { listReports } from '../services/reports';
import { ALERT_TYPES, MAX_EXTRA_REGIONS, REPORT_TYPES } from '../../shared/constants';
import { isRegionId } from '../../shared/regions';
import type { PaymentRow, UserSettings } from '../../shared/types';

export const meRoutes = new Hono<AppEnv>();

const threat = z.enum([...new Set([...ALERT_TYPES, ...REPORT_TYPES])] as [string, ...string[]]);
const patchSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  regionId: z.string().nullable().optional(),
  extraRegions: z.array(z.string()).max(MAX_EXTRA_REGIONS).optional(),
  settings: z
    .object({
      notify: z
        .object({
          enabled: z.boolean(),
          official: z.boolean(),
          userReports: z.boolean(),
          allClear: z.boolean(),
          types: z.array(threat),
        })
        .partial()
        .optional(),
      view: z.object({ hideUserReports: z.boolean(), showOfficial: z.boolean(), sound: z.boolean() }).partial().optional(),
    })
    .optional(),
});

/** Keep the user's push subscriptions in sync with the account preferences. */
export function syncUserSubscriptions(userId: number) {
  const u = getUser(userId);
  if (!u) return;
  const regions = [u.region_id, ...JSON.parse(u.extra_regions || '[]')].filter(Boolean);
  db.prepare('UPDATE push_subscriptions SET regions = ?, prefs = ? WHERE user_id = ?').run(
    JSON.stringify(regions),
    JSON.stringify(userSettings(u).notify),
    userId,
  );
}

meRoutes.patch('/', async (c) => {
  const u = requireUser(c);
  const data = await body(c, patchSchema);
  if (data.regionId !== undefined && data.regionId !== null && !isRegionId(data.regionId)) fail(400, 'Неизвестный регион');
  const regionId = data.regionId !== undefined ? data.regionId : u.region_id;
  const extra =
    data.extraRegions !== undefined
      ? [...new Set(data.extraRegions.filter(isRegionId))].filter((r) => r !== regionId)
      : JSON.parse(u.extra_regions || '[]');
  const cur = userSettings(u);
  const settings: UserSettings = {
    notify: { ...cur.notify, ...(data.settings?.notify || {}) } as UserSettings['notify'],
    view: { ...cur.view, ...(data.settings?.view || {}) },
  };
  db.prepare('UPDATE users SET name = ?, region_id = ?, extra_regions = ?, settings = ? WHERE id = ?').run(
    data.name ?? u.name,
    regionId,
    JSON.stringify(extra),
    JSON.stringify(settings),
    u.id,
  );
  syncUserSubscriptions(u.id);
  return c.json({ user: toPublicUser(getUser(u.id)!) });
});

meRoutes.delete('/', async (c) => {
  const u = requireUser(c);
  const data = await body(c, z.object({ password: z.string() }));
  if (!verifyPassword(data.password, u.password_hash)) fail(400, 'Неверный пароль');
  destroySession(c);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return c.json({ ok: true });
});

meRoutes.get('/reports', (c) => {
  const u = requireUser(c);
  return c.json({ reports: listReports({ userId: u.id, limit: 100, includeRemoved: true }) });
});

meRoutes.get('/payments', (c) => {
  const u = requireUser(c);
  const rows = db
    .prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(u.id) as { id: number; provider: string; plan: 'month' | 'year'; amount: number; currency: string; status: string; created_at: number; paid_at: number | null }[];
  const payments: PaymentRow[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    plan: r.plan,
    amount: r.amount / 100,
    currency: r.currency,
    status: r.status,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  }));
  return c.json({ payments });
});
