import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../auth';
import { bus } from '../bus';
import { db } from '../db';
import { DEMO_PAYMENTS } from '../env';
import { getSetting } from '../settings';
import { DAY, fail, mskHour } from '../util';
import { isPlus } from '../users';
import { vapidPublicKey } from '../services/push';
import { listActiveAlerts, listAlerts, listRegionAlerts } from '../services/alerts';
import { listActiveReports, listReports } from '../services/reports';
import { getFront } from '../services/front';
import { paymentsEnabled } from '../services/billing/yookassa';
import { isAiConfigured } from '../services/ai';
import { isRegionId } from '../../shared/regions';
import type { AppMeta, LiveState, RegionStats } from '../../shared/types';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/meta', (c) => {
  const limits = getSetting('limits');
  const plus = getSetting('plus');
  const meta: AppMeta = {
    siteName: getSetting('site').name,
    vapidPublicKey: vapidPublicKey(),
    plus,
    limits: {
      freeCooldownMin: limits.freeCooldownMin,
      plusPerHour: limits.plusPerHour,
      historyDaysFree: limits.historyDaysFree,
      historyDaysPlus: limits.historyDaysPlus,
    },
    ttl: limits.ttl,
    paymentsEnabled: paymentsEnabled(),
    demoPayments: DEMO_PAYMENTS,
    aiConfigured: isAiConfigured(),
  };
  return c.json(meta);
});

publicRoutes.get('/state', (c) => {
  const state: LiveState = { alerts: listActiveAlerts(), reports: listActiveReports(), serverTime: Date.now() };
  return c.json(state);
});

publicRoutes.get('/stream', (c) => {
  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');
  return streamSSE(c, async (stream) => {
    const unsub = bus.subscribe((ev) => {
      void stream.writeSSE({ event: 'live', data: JSON.stringify(ev) }).catch(() => undefined);
    });
    stream.onAbort(() => {
      unsub();
    });
    await stream.writeSSE({ event: 'hello', data: String(Date.now()) });
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(20_000);
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => undefined);
    }
    unsub();
  });
});

/** Recent alert feed across the country. */
publicRoutes.get('/feed', (c) => {
  const hours = Math.min(72, Math.max(1, Number(c.req.query('hours') || 24)));
  return c.json({ alerts: listAlerts({ since: Date.now() - hours * 3_600_000, limit: 300 }) });
});

publicRoutes.get('/regions/:id', (c) => {
  const id = c.req.param('id');
  if (!isRegionId(id)) fail(404, 'Регион не найден');
  const limits = getSetting('limits');
  const user = c.get('user');
  const days = isPlus(user) || (user && user.role !== 'user') ? limits.historyDaysPlus : limits.historyDaysFree;
  const t = Date.now();
  const history = listRegionAlerts(id, t - days * DAY, 500);
  const hourly = new Array(24).fill(0) as number[];
  for (const a of history) hourly[mskHour(a.startedAt)]!++;
  const count = (since: number) =>
    (db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE region_id = ? AND started_at >= ?').get(id, since) as { n: number }).n;
  const stats: RegionStats = {
    regionId: id,
    active: listActiveAlerts().filter((a) => a.regionId === id),
    reports: listActiveReports().filter((r) => r.regionId === id),
    alerts24h: count(t - DAY),
    alerts7d: count(t - 7 * DAY),
    reports24h: listReports({ regionId: id, since: t - DAY, limit: 1000 }).length,
    lastAlertAt: history[0]?.startedAt ?? null,
    hourly,
    history: history.slice(0, 100),
    historyDays: days,
  };
  return c.json(stats);
});

publicRoutes.get('/front', (c) => c.json(getFront()));
