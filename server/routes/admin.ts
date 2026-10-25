import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole, requireUser, type AppEnv } from '../auth';
import { db, type UserRow } from '../db';
import { getSetting, publicSetting, setSetting, type Settings } from '../settings';
import { body, DAY, fail } from '../util';
import { extendPlus, getUser, toPublicUser } from '../users';
import { endAlert, endRegionAlerts, listActiveAlerts, listAlerts, startAlert } from '../services/alerts';
import { listReports, removeReport } from '../services/reports';
import {
  getFront,
  getFrontConfig,
  importFrontFromUrl,
  normalizeFrontGeoJson,
  resetFrontToDemo,
  saveFront,
  setFrontConfig,
} from '../services/front';
import { ALERT_TYPES, REPORT_TYPES } from '../../shared/constants';
import { isRegionId } from '../../shared/regions';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireRole('admin', 'moderator'));
const adminOnly = requireRole('admin');

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

adminRoutes.get('/overview', (c) => {
  const t = Date.now();
  return c.json({
    users: count('SELECT COUNT(*) AS n FROM users'),
    plusUsers: count('SELECT COUNT(*) AS n FROM users WHERE plus_until > ?', t),
    newUsers24h: count('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', t - DAY),
    activeAlerts: count('SELECT COUNT(*) AS n FROM alerts WHERE ended_at IS NULL'),
    alerts24h: count('SELECT COUNT(*) AS n FROM alerts WHERE started_at > ?', t - DAY),
    activeReports: count('SELECT COUNT(*) AS n FROM reports WHERE removed = 0 AND expires_at > ?', t),
    reports24h: count('SELECT COUNT(*) AS n FROM reports WHERE created_at > ?', t - DAY),
    pushSubscriptions: count('SELECT COUNT(*) AS n FROM push_subscriptions'),
    sources: count('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1'),
    posts24h: count('SELECT COUNT(*) AS n FROM source_posts WHERE posted_at > ?', t - DAY),
    forecasts24h: count('SELECT COUNT(*) AS n FROM forecasts WHERE created_at > ?', t - DAY),
    revenue30d:
      ((db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'succeeded' AND provider != 'demo' AND paid_at > ?")
        .get(t - 30 * DAY) as { n: number }).n || 0) / 100,
  });
});

/* ---------- alerts ---------- */

adminRoutes.get('/alerts', (c) => {
  const active = c.req.query('active') === '1';
  return c.json({ alerts: active ? listActiveAlerts() : listAlerts({ since: Date.now() - 3 * DAY, limit: 500 }) });
});

adminRoutes.post('/alerts', async (c) => {
  const u = requireUser(c);
  const data = await body(
    c,
    z.object({
      regionIds: z.array(z.string()).min(1).max(100),
      type: z.enum(ALERT_TYPES),
      message: z.string().trim().max(300).nullable().optional(),
    }),
  );
  const ids = data.regionIds.filter(isRegionId);
  if (!ids.length) fail(400, 'Выберите регионы');
  const alerts = ids.map(
    (regionId) => startAlert({ regionId, type: data.type, source: 'admin', message: data.message || null, createdBy: u.id }).alert,
  );
  return c.json({ alerts });
});

adminRoutes.post('/alerts/:id/end', (c) => {
  const a = endAlert(Number(c.req.param('id')), 'admin');
  if (!a) fail(404, 'Тревога не найдена или уже завершена');
  return c.json({ alert: a });
});

adminRoutes.post('/alerts/end-region', async (c) => {
  const { regionId } = await body(c, z.object({ regionId: z.string() }));
  return c.json({ ended: endRegionAlerts(regionId, 'admin').length });
});

/* ---------- reports (marks) ---------- */

adminRoutes.get('/reports', (c) =>
  c.json({ reports: listReports({ since: Date.now() - 2 * DAY, limit: 500, includeRemoved: true }) }),
);

adminRoutes.delete('/reports/:id', (c) => c.json({ ok: removeReport(Number(c.req.param('id'))) }));

/* ---------- users ---------- */

adminRoutes.get('/users', adminOnly, (c) => {
  const q = (c.req.query('q') || '').trim();
  const rows = (
    q
      ? db.prepare('SELECT * FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 200').all(`%${q}%`, `%${q}%`)
      : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 200').all()
  ) as UserRow[];
  const reportsBy = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ?');
  return c.json({
    users: rows.map((u) => ({ ...toPublicUser(u), banned: !!u.banned, reports: (reportsBy.get(u.id) as { n: number }).n })),
  });
});

adminRoutes.patch('/users/:id', adminOnly, async (c) => {
  const me = requireUser(c);
  const id = Number(c.req.param('id'));
  const u = getUser(id);
  if (!u) fail(404, 'Пользователь не найден');
  const data = await body(
    c,
    z.object({
      role: z.enum(['user', 'moderator', 'admin']).optional(),
      banned: z.boolean().optional(),
      grantPlusDays: z.number().int().min(1).max(3650).optional(),
      revokePlus: z.boolean().optional(),
    }),
  );
  if (id === me.id && (data.role && data.role !== 'admin' || data.banned)) fail(400, 'Нельзя понизить или заблокировать себя');
  if (data.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(data.role, id);
  if (data.banned !== undefined) {
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(data.banned ? 1 : 0, id);
    if (data.banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (data.grantPlusDays) extendPlus(id, data.grantPlusDays);
  if (data.revokePlus) db.prepare('UPDATE users SET plus_until = NULL WHERE id = ?').run(id);
  return c.json({ user: toPublicUser(getUser(id)!) });
});

adminRoutes.get('/payments', adminOnly, (c) => {
  const rows = db
    .prepare(
      `SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200`,
    )
    .all();
  return c.json({ payments: rows });
});

/* ---------- settings ---------- */

const ttlSchema = z.object(Object.fromEntries(REPORT_TYPES.map((t) => [t, z.number().min(1).max(600)])) as Record<string, z.ZodNumber>);
const settingSchemas = {
  site: z.object({ name: z.string().trim().min(1).max(40) }).partial(),
  limits: z
    .object({
      freeCooldownMin: z.number().int().min(0).max(1440),
      plusPerHour: z.number().int().min(1).max(1000),
      alertMaxHours: z.number().min(0.5).max(48),
      ttl: ttlSchema.partial(),
      dismissThreshold: z.number().int().min(1).max(50),
      historyDaysFree: z.number().int().min(1).max(365),
      historyDaysPlus: z.number().int().min(1).max(365),
    })
    .partial(),
  plus: z.object({ priceMonth: z.number().min(1).max(100000), priceYear: z.number().min(1).max(1000000), currency: z.string().length(3) }).partial(),
  yookassa: z
    .object({ enabled: z.boolean(), shopId: z.string().trim().max(40), secretKey: z.string().trim().max(200), receipt: z.boolean(), vatCode: z.number().int().min(1).max(12) })
    .partial(),
  ai: z
    .object({
      autoIntervalMin: z.number().int().min(0).max(1440),
      userCanChoose: z.boolean(),
      refreshCooldownMin: z.number().int().min(0).max(1440),
      extraPrompt: z.string().max(8000),
      maxPosts: z.number().int().min(0).max(600),
    })
    .partial(),
} as const;
type EditableKey = keyof typeof settingSchemas;

adminRoutes.get('/settings', adminOnly, (c) =>
  c.json(Object.fromEntries((Object.keys(settingSchemas) as EditableKey[]).map((k) => [k, publicSetting(k)]))),
);

adminRoutes.put('/settings/:key', adminOnly, async (c) => {
  const key = c.req.param('key') as EditableKey;
  const schema = settingSchemas[key];
  if (!schema) fail(404, 'Неизвестный раздел настроек');
  const data = (await body(c, schema as z.ZodType<Record<string, unknown>>)) as Record<string, unknown>;
  // Masked secrets coming back from the UI mean "unchanged".
  if (key === 'yookassa' && typeof data.secretKey === 'string' && (data.secretKey.includes('•') || !data.secretKey)) delete data.secretKey;
  if (key === 'limits' && data.ttl) data.ttl = { ...getSetting('limits').ttl, ...(data.ttl as object) };
  setSetting(key, data as Partial<Settings[EditableKey]>);
  return c.json(publicSetting(key));
});

/* ---------- front line ---------- */

adminRoutes.get('/front', adminOnly, (c) => c.json({ front: getFront(), config: getFrontConfig() }));

const arrowSchema = z.object({
  id: z.string().max(40),
  side: z.enum(['ru', 'ua']),
  coords: z.array(z.tuple([z.number(), z.number()])).min(2).max(50),
  label: z.string().max(80).optional(),
  date: z.string().max(40).optional(),
});

adminRoutes.put('/front', adminOnly, async (c) => {
  const data = await body(
    c,
    z.object({
      geojson: z.unknown().optional(),
      arrows: z.array(arrowSchema).max(200).optional(),
      source: z.string().max(120).nullable().optional(),
      note: z.string().max(300).nullable().optional(),
    }),
  );
  const prev = getFront();
  let geojson = prev.geojson;
  let arrows = data.arrows ?? (prev.isDemo ? [] : prev.arrows);
  if (data.geojson !== undefined) {
    try {
      const n = normalizeFrontGeoJson(data.geojson);
      geojson = n.geojson;
      if (!data.arrows && n.arrows.length) arrows = n.arrows;
    } catch (e) {
      fail(400, (e as Error).message);
    }
  }
  const front = saveFront({ geojson, arrows, source: data.source ?? prev.source ?? 'Админ-панель', note: data.note ?? null, isDemo: false });
  return c.json({ front });
});

adminRoutes.put('/front/config', adminOnly, async (c) => {
  const data = await body(c, z.object({ sourceUrl: z.string().max(500), autoRefreshMin: z.number().int().min(0).max(1440) }).partial());
  if (data.sourceUrl) {
    try {
      new URL(data.sourceUrl);
    } catch {
      fail(400, 'Некорректный URL');
    }
  }
  setFrontConfig(data);
  return c.json({ config: getFrontConfig() });
});

adminRoutes.post('/front/import', adminOnly, async (c) => {
  const cfg = getFrontConfig();
  const { url } = await body(c, z.object({ url: z.string().max(500).optional() }));
  const target = url || cfg.sourceUrl;
  if (!target) fail(400, 'Укажите URL источника');
  try {
    return c.json({ front: await importFrontFromUrl(target) });
  } catch (e) {
    setFrontConfig({ lastError: (e as Error).message });
    fail(502, `Импорт не удался: ${(e as Error).message}`);
  }
});

adminRoutes.post('/front/reset-demo', adminOnly, (c) => {
  resetFrontToDemo();
  return c.json({ front: getFront() });
});
