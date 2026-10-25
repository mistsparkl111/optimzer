import { db, type UserRow } from './db';
import { getSetting } from './settings';
import { parseJson, MIN } from './util';
import { ALERT_TYPES, REPORT_TYPES } from '../shared/constants';
import type { PublicUser, UserSettings } from '../shared/types';

export const DEFAULT_USER_SETTINGS: UserSettings = {
  notify: {
    enabled: true,
    official: true,
    userReports: true,
    allClear: true,
    types: [...new Set([...ALERT_TYPES, ...REPORT_TYPES])],
  },
  view: { hideUserReports: false, showOfficial: true, sound: true },
};

export function userSettings(row: Pick<UserRow, 'settings'>): UserSettings {
  const s = parseJson<Partial<UserSettings>>(row.settings, {});
  return {
    notify: { ...DEFAULT_USER_SETTINGS.notify, ...(s.notify || {}) },
    view: { ...DEFAULT_USER_SETTINGS.view, ...(s.view || {}) },
  };
}

/** The only administrator is the account with this nickname (case-insensitive). */
export const LEADER_NICK = 'leader';
export const isLeaderName = (name: string) => name.trim().toLowerCase() === LEADER_NICK;
export const effectiveRole = (u: Pick<UserRow, 'name'>): UserRow['role'] => (isLeaderName(u.name) ? 'admin' : 'user');

/** Persist roles so the DB always matches the rule: leader is admin, everyone else is a regular user. */
export function syncLeaderRole() {
  db.prepare("UPDATE users SET role = 'admin' WHERE lower(trim(name)) = ? AND role != 'admin'").run(LEADER_NICK);
  const demoted = db.prepare("UPDATE users SET role = 'user' WHERE lower(trim(name)) != ? AND role != 'user'").run(LEADER_NICK);
  if (demoted.changes) console.log(`[auth] права администратора сняты у ${demoted.changes} польз. — админ только у ника «${LEADER_NICK}»`);
}

/** Nickname already used by another account (case-insensitive for Latin letters). */
export function nameTaken(name: string, exceptUserId?: number): boolean {
  const row = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(name.trim()) as { id: number } | undefined;
  return !!row && row.id !== exceptUserId;
}

export const isPlus = (u: Pick<UserRow, 'plus_until'> | null | undefined) => !!u?.plus_until && u.plus_until > Date.now();

/** Free tier: when may the user place the next mark (null = right now). */
export function nextReportAt(u: UserRow): number | null {
  if (isPlus(u) || effectiveRole(u) !== 'user') return null;
  const last = db.prepare('SELECT MAX(created_at) AS t FROM reports WHERE user_id = ?').get(u.id) as { t: number | null };
  if (!last.t) return null;
  const next = last.t + getSetting('limits').freeCooldownMin * MIN;
  return next > Date.now() ? next : null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: effectiveRole(u),
    regionId: u.region_id,
    extraRegions: parseJson<string[]>(u.extra_regions, []),
    settings: userSettings(u),
    plusUntil: u.plus_until,
    isPlus: isPlus(u),
    nextReportAt: nextReportAt(u),
    createdAt: u.created_at,
  };
}

export const getUser = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
export const getUserByEmail = (email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as UserRow | undefined;
export const getUserByName = (name: string) =>
  db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name.trim()) as UserRow | undefined;

/** Extend Radar+ by N days from max(now, current expiry). */
export function extendPlus(userId: number, days: number): number {
  const u = getUser(userId);
  if (!u) throw new Error('user not found');
  const base = Math.max(Date.now(), u.plus_until || 0);
  const until = base + days * 24 * 60 * MIN;
  db.prepare('UPDATE users SET plus_until = ? WHERE id = ?').run(until, userId);
  return until;
}
