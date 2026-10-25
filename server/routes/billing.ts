import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv } from '../auth';
import { db } from '../db';
import { DEMO_PAYMENTS } from '../env';
import { getSetting } from '../settings';
import { body, fail, rateLimit } from '../util';
import { extendPlus, getUser, toPublicUser } from '../users';
import { createYookassaPayment, handleYookassaWebhook, PLAN_DAYS, paymentsEnabled, planPrice } from '../services/billing/yookassa';

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.post('/checkout', async (c) => {
  const u = requireUser(c);
  const { plan } = await body(c, z.object({ plan: z.enum(['month', 'year']) }));
  if (!rateLimit(`checkout:${u.id}`, 10, 3_600_000)) fail(429, 'Слишком много попыток оплаты');
  if (paymentsEnabled()) {
    const url = await createYookassaPayment(u, plan);
    return c.json({ confirmationUrl: url });
  }
  if (!DEMO_PAYMENTS) fail(503, 'Оплата временно недоступна');
  // Demo mode (development): activate immediately without charging.
  db.prepare(
    `INSERT INTO payments (user_id, provider, plan, amount, currency, status, created_at, paid_at, applied)
     VALUES (?, 'demo', ?, ?, ?, 'succeeded', ?, ?, 1)`,
  ).run(u.id, plan, planPrice(plan) * 100, getSetting('plus').currency, Date.now(), Date.now());
  extendPlus(u.id, PLAN_DAYS[plan]);
  return c.json({ demo: true, user: toPublicUser(getUser(u.id)!) });
});

billingRoutes.post('/webhook/yookassa', async (c) => {
  const payload = await c.req.json().catch(() => ({}));
  await handleYookassaWebhook(payload);
  return c.json({ ok: true });
});
