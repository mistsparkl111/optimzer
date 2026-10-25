import { db } from '../../db';
import { getSetting } from '../../settings';
import { PUBLIC_URL } from '../../env';
import { extendPlus } from '../../users';
import { fail } from '../../util';

const API = 'https://api.yookassa.ru/v3';

export type Plan = 'month' | 'year';
export const PLAN_DAYS: Record<Plan, number> = { month: 30, year: 365 };

export function planPrice(plan: Plan) {
  const p = getSetting('plus');
  return plan === 'year' ? p.priceYear : p.priceMonth;
}

export const paymentsEnabled = () => {
  const y = getSetting('yookassa');
  return y.enabled && !!y.shopId && !!y.secretKey;
};

function authHeader() {
  const y = getSetting('yookassa');
  return 'Basic ' + Buffer.from(`${y.shopId}:${y.secretKey}`).toString('base64');
}

interface YkPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid: boolean;
  amount: { value: string; currency: string };
  confirmation?: { type: string; confirmation_url?: string };
  metadata?: Record<string, string>;
}

/** Creates a ЮKassa payment and returns the confirmation (redirect) URL. */
export async function createYookassaPayment(user: { id: number; email: string }, plan: Plan): Promise<string> {
  const y = getSetting('yookassa');
  const amount = planPrice(plan);
  const currency = getSetting('plus').currency || 'RUB';
  const local = db
    .prepare(
      `INSERT INTO payments (user_id, provider, plan, amount, currency, status, created_at) VALUES (?, 'yookassa', ?, ?, ?, 'pending', ?)`,
    )
    .run(user.id, plan, amount * 100, currency, Date.now());
  const localId = Number(local.lastInsertRowid);
  const description = `Радар+ — ${plan === 'year' ? '12 месяцев' : '1 месяц'}`;
  const value = amount.toFixed(2);
  const body: Record<string, unknown> = {
    amount: { value, currency },
    capture: true,
    confirmation: { type: 'redirect', return_url: `${PUBLIC_URL}/plus?payment=${localId}` },
    description,
    metadata: { userId: String(user.id), plan, paymentId: String(localId) },
  };
  if (y.receipt) {
    body.receipt = {
      customer: { email: user.email },
      items: [
        {
          description,
          quantity: '1.00',
          amount: { value, currency },
          vat_code: y.vatCode || 1,
          payment_mode: 'full_payment',
          payment_subject: 'service',
        },
      ],
    };
  }
  const res = await fetch(`${API}/payments`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Idempotence-Key': `radar-${localId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as YkPayment & { description?: string };
  if (!res.ok || !data.confirmation?.confirmation_url) {
    db.prepare("UPDATE payments SET status = 'error' WHERE id = ?").run(localId);
    console.error('[yookassa] create failed', res.status, data);
    fail(502, 'Платёжная система недоступна, попробуйте позже');
  }
  db.prepare('UPDATE payments SET external_id = ? WHERE id = ?').run(data.id, localId);
  return data.confirmation.confirmation_url!;
}

/**
 * Webhook handler. The notification body is not trusted: the payment is re-fetched
 * from the ЮKassa API with our credentials before granting anything.
 */
export async function handleYookassaWebhook(payload: { event?: string; object?: { id?: string } }) {
  const id = payload.object?.id;
  if (!id || !paymentsEnabled()) return;
  const res = await fetch(`${API}/payments/${encodeURIComponent(id)}`, { headers: { Authorization: authHeader() } });
  if (!res.ok) return;
  const p = (await res.json()) as YkPayment;
  const row = db.prepare('SELECT * FROM payments WHERE external_id = ?').get(p.id) as
    | { id: number; user_id: number; plan: Plan; applied: number; amount: number }
    | undefined;
  if (!row) return;
  if (p.status === 'succeeded' && p.paid) {
    const paidKop = Math.round(parseFloat(p.amount.value) * 100);
    if (paidKop < row.amount) {
      console.warn('[yookassa] amount mismatch for payment', row.id);
      return;
    }
    const apply = db.transaction(() => {
      const fresh = db.prepare('SELECT applied FROM payments WHERE id = ?').get(row.id) as { applied: number };
      if (fresh.applied) return;
      db.prepare("UPDATE payments SET status = 'succeeded', paid_at = ?, applied = 1 WHERE id = ?").run(Date.now(), row.id);
      extendPlus(row.user_id, PLAN_DAYS[row.plan]);
    });
    apply();
  } else if (p.status === 'canceled') {
    db.prepare("UPDATE payments SET status = 'canceled' WHERE id = ?").run(row.id);
  }
}
