import { db, type UserRow } from '../db';
import { bus } from '../bus';
import { getSetting } from '../settings';
import { fail, HOUR, MIN } from '../util';
import { nearestRegion } from '../geo';
import { isPlus, nextReportAt } from '../users';
import { notifyRegion } from './push';
import { THREATS, type ReportType } from '../../shared/constants';
import { regionName } from '../../shared/regions';
import type { Report } from '../../shared/types';

interface ReportRow {
  id: number;
  user_id: number;
  type: ReportType;
  lat: number;
  lon: number;
  region_id: string | null;
  heading: number | null;
  count: number | null;
  comment: string | null;
  is_plus: number;
  ttl_ms: number;
  created_at: number;
  expires_at: number;
  confirms: number;
  dismisses: number;
  removed: number;
  author?: string;
}

const SELECT = `SELECT r.*, u.name AS author FROM reports r JOIN users u ON u.id = r.user_id`;

export function toReport(r: ReportRow): Report {
  return {
    id: r.id,
    type: r.type,
    lat: r.lat,
    lon: r.lon,
    regionId: r.region_id,
    heading: r.heading,
    count: r.count,
    comment: r.comment,
    author: r.author || 'Пользователь',
    isPlus: !!r.is_plus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ttlMs: r.ttl_ms,
    confirms: r.confirms,
    dismisses: r.dismisses,
  };
}

export function getReport(id: number): Report | null {
  const r = db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as ReportRow | undefined;
  return r ? toReport(r) : null;
}

export function listActiveReports(): Report[] {
  return (
    db.prepare(`${SELECT} WHERE r.removed = 0 AND r.expires_at > ? ORDER BY r.created_at DESC LIMIT 2000`).all(Date.now()) as ReportRow[]
  ).map(toReport);
}

export function listReports(opts: { since?: number; userId?: number; regionId?: string; limit?: number; includeRemoved?: boolean }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.since) (where.push('r.created_at >= ?'), args.push(opts.since));
  if (opts.userId) (where.push('r.user_id = ?'), args.push(opts.userId));
  if (opts.regionId) (where.push('r.region_id = ?'), args.push(opts.regionId));
  if (!opts.includeRemoved) where.push('r.removed = 0');
  const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, opts.limit ?? 200) as ReportRow[]).map(toReport);
}

export interface NewReport {
  type: ReportType;
  lat: number;
  lon: number;
  heading?: number | null;
  count?: number | null;
  comment?: string | null;
}

export function createReport(user: UserRow, input: NewReport): Report {
  const limits = getSetting('limits');
  const plus = isPlus(user) || user.role !== 'user';
  if (!plus) {
    const next = nextReportAt(user);
    if (next) {
      const mins = Math.ceil((next - Date.now()) / MIN);
      fail(429, `Без Радар+ можно ставить одну метку в ${limits.freeCooldownMin} мин. Следующая — через ${mins} мин.`);
    }
  } else if (user.role === 'user') {
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND created_at > ?')
      .get(user.id, Date.now() - HOUR) as { n: number };
    if (n.n >= limits.plusPerHour) fail(429, `Лимит защиты от спама: не больше ${limits.plusPerHour} меток в час.`);
  }

  const regionId = nearestRegion(input.lon, input.lat, 40);
  if (!regionId) fail(400, 'Метку можно поставить только на территории регионов карты');

  // Collapse duplicates: same author, type, ~15 km, last 5 min -> refresh instead of a new mark.
  const dup = db
    .prepare(
      `SELECT id FROM reports WHERE user_id = ? AND type = ? AND removed = 0 AND expires_at > ? AND created_at > ?
       AND ABS(lat - ?) < 0.15 AND ABS(lon - ?) < 0.25`,
    )
    .get(user.id, input.type, Date.now(), Date.now() - 5 * MIN, input.lat, input.lon) as { id: number } | undefined;
  if (dup) fail(409, 'Вы уже отметили эту угрозу рядом — подтвердите существующую метку');

  const ttlMs = (limits.ttl[input.type] || THREATS[input.type].ttlMin) * MIN;
  const t = Date.now();
  const info = db
    .prepare(
      `INSERT INTO reports (user_id, type, lat, lon, region_id, heading, count, comment, is_plus, ttl_ms, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      input.type,
      round(input.lat),
      round(input.lon),
      regionId,
      input.heading ?? null,
      input.count ?? null,
      input.comment?.trim() || null,
      isPlus(user) ? 1 : 0,
      ttlMs,
      t,
      t + ttlMs,
    );
  const report = getReport(Number(info.lastInsertRowid))!;
  bus.publish({ type: 'report', report });
  const meta = THREATS[report.type];
  void notifyRegion(
    regionId,
    {
      title: `⚠️ ${meta.label}: сообщение ${report.isPlus ? 'от Радар+' : 'от пользователя'}`,
      body: `${regionName(regionId)}${report.comment ? ` — ${report.comment}` : ''}. Не подтверждено официально.`,
      tag: `report-${regionId}`,
      url: `/?region=${regionId}&report=${report.id}`,
      kind: 'report',
      threat: report.type,
      regionId,
      ts: t,
    },
    'user',
    { excludeUserId: user.id },
  );
  return report;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Votes drive the fade-out logic:
 * - "Подтверждаю" extends the mark's life (up to 3x the base lifetime);
 * - "Уже нет" votes reaching the threshold (and outweighing confirmations) remove it at once.
 * Radar+ / staff votes weigh double.
 */
export function voteReport(user: UserRow, id: number, vote: 1 | -1): Report | null {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  if (!r || r.removed || r.expires_at <= Date.now()) fail(404, 'Метка уже исчезла');
  if (r.user_id === user.id) fail(400, 'Нельзя голосовать за свою метку');
  const weight = isPlus(user) || user.role !== 'user' ? 2 : 1;
  const t = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO report_votes (report_id, user_id, vote, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(report_id, user_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
    ).run(id, user.id, vote * weight, t);
    const sums = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN vote > 0 THEN vote END), 0) AS c, COALESCE(SUM(CASE WHEN vote < 0 THEN -vote END), 0) AS d
         FROM report_votes WHERE report_id = ?`,
      )
      .get(id) as { c: number; d: number };
    let expires = r.expires_at;
    if (vote > 0) expires = Math.min(r.created_at + r.ttl_ms * 3, Math.max(r.expires_at, t + r.ttl_ms * 0.6));
    const threshold = getSetting('limits').dismissThreshold;
    if (sums.d >= threshold && sums.d > sums.c) expires = t;
    db.prepare('UPDATE reports SET confirms = ?, dismisses = ?, expires_at = ? WHERE id = ?').run(sums.c, sums.d, expires, id);
  })();
  const updated = getReport(id)!;
  if (updated.expiresAt <= Date.now()) {
    db.prepare('UPDATE reports SET expired_notified = 1 WHERE id = ?').run(id);
    bus.publish({ type: 'report_remove', id });
    return null;
  }
  bus.publish({ type: 'report', report: updated });
  return updated;
}

export function removeReport(id: number) {
  const res = db.prepare('UPDATE reports SET removed = 1 WHERE id = ? AND removed = 0').run(id);
  if (res.changes) bus.publish({ type: 'report_remove', id });
  return res.changes > 0;
}

/** Announce marks whose lifetime ran out so clients drop them. */
export function sweepReports() {
  const rows = db
    .prepare('SELECT id FROM reports WHERE removed = 0 AND expired_notified = 0 AND expires_at <= ?')
    .all(Date.now()) as { id: number }[];
  if (!rows.length) return;
  const mark = db.prepare('UPDATE reports SET expired_notified = 1 WHERE id = ?');
  for (const r of rows) {
    mark.run(r.id);
    bus.publish({ type: 'report_remove', id: r.id });
  }
}
