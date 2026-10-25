import { db } from './db';
import { decrypt, encrypt, maskSecret } from './crypto';
import { REPORT_TYPES, THREATS, type ReportType } from '../shared/constants';

export interface Settings {
  site: { name: string };
  limits: {
    /** Free users: one mark per N minutes. */
    freeCooldownMin: number;
    /** Radar+ anti-spam cap per hour. */
    plusPerHour: number;
    /** Official alerts auto-end after N hours without all-clear. */
    alertMaxHours: number;
    /** Mark lifetimes, minutes. */
    ttl: Record<ReportType, number>;
    /** "Уже нет" votes needed to hide a mark early. */
    dismissThreshold: number;
    historyDaysFree: number;
    historyDaysPlus: number;
  };
  plus: { priceMonth: number; priceYear: number; currency: string };
  yookassa: {
    enabled: boolean;
    shopId: string;
    secretKey: string; // stored encrypted
    receipt: boolean;
    vatCode: number;
  };
  ai: {
    /** Auto-generate a forecast with the default model every N minutes (0 = off). */
    autoIntervalMin: number;
    /** Viewers may pick among enabled models. */
    userCanChoose: boolean;
    /** Minimum minutes between on-demand refreshes per user. */
    refreshCooldownMin: number;
    /** Extra instructions appended to the system prompt by the admin. */
    extraPrompt: string;
    /** Max source posts fed to the model. */
    maxPosts: number;
  };
  vapid: { publicKey: string; privateKey: string; subject: string };
}

const ttlDefaults = Object.fromEntries(REPORT_TYPES.map((t) => [t, THREATS[t].ttlMin])) as Record<ReportType, number>;

export const DEFAULTS: Settings = {
  site: { name: 'Радар' },
  limits: {
    freeCooldownMin: 60,
    plusPerHour: 20,
    alertMaxHours: 6,
    ttl: ttlDefaults,
    dismissThreshold: 3,
    historyDaysFree: 7,
    historyDaysPlus: 30,
  },
  plus: { priceMonth: 199, priceYear: 1490, currency: 'RUB' },
  yookassa: { enabled: false, shopId: '', secretKey: '', receipt: false, vatCode: 1 },
  ai: { autoIntervalMin: 60, userCanChoose: true, refreshCooldownMin: 10, extraPrompt: '', maxPosts: 120 },
  vapid: { publicKey: '', privateKey: '', subject: '' },
};

/** Fields encrypted at rest. */
const SECRET_FIELDS: Partial<Record<keyof Settings, string[]>> = {
  yookassa: ['secretKey'],
  vapid: ['privateKey'],
};

const cache = new Map<string, unknown>();

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  if (cache.has(key)) return cache.get(key) as Settings[K];
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  let stored: Record<string, unknown> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = {};
    }
  }
  for (const f of SECRET_FIELDS[key] || []) if (typeof stored[f] === 'string') stored[f] = decrypt(stored[f] as string);
  const def = DEFAULTS[key] as Record<string, unknown>;
  const merged = { ...def, ...stored } as Record<string, unknown>;
  // one level deep merge for nested objects (e.g. limits.ttl)
  for (const k of Object.keys(def)) {
    const dv = def[k];
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) merged[k] = { ...dv, ...((stored[k] as object) || {}) };
  }
  cache.set(key, merged);
  return merged as Settings[K];
}

export function setSetting<K extends keyof Settings>(key: K, value: Partial<Settings[K]>): Settings[K] {
  const next = { ...getSetting(key), ...value } as Record<string, unknown>;
  const toStore = { ...next };
  for (const f of SECRET_FIELDS[key] || []) if (typeof toStore[f] === 'string') toStore[f] = toStore[f] ? encrypt(toStore[f] as string) : '';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(toStore),
  );
  cache.delete(key);
  return getSetting(key);
}

/** Settings safe to send to the admin UI (secrets masked). */
export function publicSetting<K extends keyof Settings>(key: K): Settings[K] & { _masked?: string[] } {
  const v = { ...getSetting(key) } as Record<string, unknown>;
  const masked: string[] = [];
  for (const f of SECRET_FIELDS[key] || []) {
    if (v[f]) masked.push(f);
    v[f] = maskSecret((v[f] as string) || '');
  }
  return { ...(v as Settings[K]), _masked: masked };
}

/** Raw JSON blobs (front line data etc.) */
export function getJson<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
