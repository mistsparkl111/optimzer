import webpush from 'web-push';
import { db } from '../db';
import { PUBLIC_URL, VAPID_SUBJECT } from '../env';
import { getSetting, setSetting } from '../settings';
import { MIN, parseJson } from '../util';
import type { ThreatType } from '../../shared/constants';
import type { NotifyPrefs } from '../../shared/types';
import { DEFAULT_USER_SETTINGS } from '../users';

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  kind: 'alert' | 'allclear' | 'report' | 'test';
  threat?: ThreatType;
  regionId?: string;
  ts: number;
}

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: number | null;
  regions: string;
  prefs: string;
  fail_count: number;
}

let ready = false;

export function initPush() {
  let v = getSetting('vapid');
  if (!v.publicKey || !v.privateKey) {
    const keys = webpush.generateVAPIDKeys();
    v = setSetting('vapid', {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: VAPID_SUBJECT || (PUBLIC_URL.startsWith('https://') ? PUBLIC_URL : 'mailto:admin@radar.local'),
    });
  }
  webpush.setVapidDetails(v.subject || 'mailto:admin@radar.local', v.publicKey, v.privateKey);
  ready = true;
}

export const vapidPublicKey = () => getSetting('vapid').publicKey || null;

export function subPrefs(row: Pick<SubRow, 'prefs'>): NotifyPrefs {
  return { ...DEFAULT_USER_SETTINGS.notify, ...parseJson<Partial<NotifyPrefs>>(row.prefs, {}) };
}

async function sendOne(sub: SubRow, payload: PushPayload, urgency: 'high' | 'normal' = 'high') {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: payload.kind === 'report' ? 900 : 3600, urgency, topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) },
    );
    db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?').run(Date.now(), sub.id);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410 || sub.fail_count >= 20) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
    } else {
      db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(sub.id);
    }
    return false;
  }
}

async function sendMany(subs: SubRow[], payload: PushPayload, urgency: 'high' | 'normal' = 'high') {
  let ok = 0;
  for (let i = 0; i < subs.length; i += 50) {
    const res = await Promise.allSettled(subs.slice(i, i + 50).map((s) => sendOne(s, payload, urgency)));
    ok += res.filter((r) => r.status === 'fulfilled' && r.value).length;
  }
  return ok;
}

const throttle = new Map<string, number>();

/**
 * Notify every subscription watching the region.
 * kind: 'official' (admin/official source alert), 'user' (mark by a person), 'allclear'.
 */
export async function notifyRegion(
  regionId: string,
  payload: PushPayload,
  kind: 'official' | 'user' | 'allclear',
  opts: { excludeUserId?: number } = {},
) {
  if (!ready) return 0;
  const subs = (db.prepare('SELECT * FROM push_subscriptions').all() as SubRow[]).filter((s) => {
    if (opts.excludeUserId && s.user_id === opts.excludeUserId) return false;
    const regions = parseJson<string[]>(s.regions, []);
    if (!regions.includes(regionId)) return false;
    const p = subPrefs(s);
    if (!p.enabled) return false;
    if (kind === 'official' && !p.official) return false;
    if (kind === 'user' && !p.userReports) return false;
    if (kind === 'allclear' && (!p.allClear || !p.official)) return false;
    if (payload.threat && !p.types.includes(payload.threat)) return false;
    if (kind === 'user') {
      // People's marks: at most one push per region per 10 minutes for each device.
      const key = `${s.id}:${regionId}`;
      const last = throttle.get(key) || 0;
      if (Date.now() - last < 10 * MIN) return false;
      throttle.set(key, Date.now());
    }
    return true;
  });
  if (!subs.length) return 0;
  return sendMany(subs, payload, kind === 'user' ? 'normal' : 'high');
}

export async function sendTest(endpoint: string) {
  const sub = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as SubRow | undefined;
  if (!sub) return false;
  return sendOne(sub, {
    title: 'Радар: проверка уведомлений',
    body: 'Так будет выглядеть тревога в вашем регионе.',
    tag: 'radar-test',
    url: '/',
    kind: 'test',
    threat: 'air',
    ts: Date.now(),
  });
}

export async function notifyUser(userId: number, payload: PushPayload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as SubRow[];
  return sendMany(subs, payload);
}
