import { db } from '../db';
import { bus } from '../bus';
import { getSetting } from '../settings';
import { HOUR } from '../util';
import { notifyRegion } from './push';
import { THREATS, type AlertType } from '../../shared/constants';
import { regionName } from '../../shared/regions';
import type { Alert } from '../../shared/types';

interface AlertRow {
  id: number;
  region_id: string;
  type: AlertType;
  source: 'admin' | 'source';
  source_id: number | null;
  source_post_id: number | null;
  message: string | null;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  end_reason: Alert['endReason'];
  source_name?: string | null;
}

const SELECT = `SELECT a.*, s.name AS source_name FROM alerts a LEFT JOIN sources s ON s.id = a.source_id`;

export function toAlert(r: AlertRow): Alert {
  return {
    id: r.id,
    regionId: r.region_id,
    type: r.type,
    source: r.source,
    sourceName: r.source === 'admin' ? 'Оперативный штаб' : r.source_name || null,
    message: r.message,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
  };
}

export function getAlert(id: number): Alert | null {
  const r = db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as AlertRow | undefined;
  return r ? toAlert(r) : null;
}

export function listActiveAlerts(): Alert[] {
  return (db.prepare(`${SELECT} WHERE a.ended_at IS NULL ORDER BY a.started_at DESC`).all() as AlertRow[]).map(toAlert);
}

export function listRegionAlerts(regionId: string, since: number, limit = 200): Alert[] {
  return (
    db
      .prepare(`${SELECT} WHERE a.region_id = ? AND a.started_at >= ? ORDER BY a.started_at DESC LIMIT ?`)
      .all(regionId, since, limit) as AlertRow[]
  ).map(toAlert);
}

export function listAlerts(opts: { since?: number; active?: boolean; limit?: number } = {}): Alert[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.since) {
    where.push('a.started_at >= ?');
    args.push(opts.since);
  }
  if (opts.active) where.push('a.ended_at IS NULL');
  const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.started_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, opts.limit ?? 500) as AlertRow[]).map(toAlert);
}

export interface StartAlertInput {
  regionId: string;
  type: AlertType;
  source: 'admin' | 'source';
  sourceId?: number | null;
  sourcePostId?: number | null;
  message?: string | null;
  createdBy?: number | null;
  /** Defaults to now; sources may pass the post time. */
  at?: number;
}

/** Start (or refresh, if the same region+type is already active) an official alert. */
export function startAlert(input: StartAlertInput): { alert: Alert; created: boolean } {
  const t = Date.now();
  const existing = db
    .prepare('SELECT id FROM alerts WHERE region_id = ? AND type = ? AND ended_at IS NULL')
    .get(input.regionId, input.type) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE alerts SET updated_at = ?, message = COALESCE(?, message) WHERE id = ?').run(
      t,
      input.message ?? null,
      existing.id,
    );
    const alert = getAlert(existing.id)!;
    bus.publish({ type: 'alert', alert });
    return { alert, created: false };
  }
  const info = db
    .prepare(
      `INSERT INTO alerts (region_id, type, source, source_id, source_post_id, message, started_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.regionId,
      input.type,
      input.source,
      input.sourceId ?? null,
      input.sourcePostId ?? null,
      input.message ?? null,
      Math.min(input.at ?? t, t),
      t,
      input.createdBy ?? null,
    );
  const alert = getAlert(Number(info.lastInsertRowid))!;
  bus.publish({ type: 'alert', alert });
  const meta = THREATS[alert.type];
  void notifyRegion(
    alert.regionId,
    {
      title: `🚨 ${meta.long}`,
      body: `${regionName(alert.regionId)}. ${alert.message || 'Пройдите в укрытие и следите за официальными сообщениями.'}`,
      tag: `alert-${alert.regionId}`,
      url: `/?region=${alert.regionId}`,
      kind: 'alert',
      threat: alert.type,
      regionId: alert.regionId,
      ts: alert.startedAt,
    },
    'official',
  );
  return { alert, created: true };
}

export function endAlert(id: number, reason: NonNullable<Alert['endReason']>): Alert | null {
  const res = db
    .prepare('UPDATE alerts SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL')
    .run(Date.now(), reason, id);
  if (!res.changes) return null;
  const alert = getAlert(id)!;
  bus.publish({ type: 'alert_end', alert });
  const stillActive = db
    .prepare('SELECT COUNT(*) AS n FROM alerts WHERE region_id = ? AND ended_at IS NULL')
    .get(alert.regionId) as { n: number };
  if (!stillActive.n && reason !== 'timeout') {
    void notifyRegion(
      alert.regionId,
      {
        title: '✅ Отбой тревоги',
        body: `${regionName(alert.regionId)}: угроза миновала.`,
        tag: `alert-${alert.regionId}`,
        url: `/?region=${alert.regionId}`,
        kind: 'allclear',
        regionId: alert.regionId,
        ts: Date.now(),
      },
      'allclear',
    );
  }
  return alert;
}

/** End all active alerts in a region (all-clear). Optionally only alerts created by a given source. */
export function endRegionAlerts(regionId: string, reason: NonNullable<Alert['endReason']>, sourceId?: number) {
  const rows = (
    sourceId
      ? db.prepare('SELECT id FROM alerts WHERE region_id = ? AND ended_at IS NULL AND source_id = ?').all(regionId, sourceId)
      : db.prepare('SELECT id FROM alerts WHERE region_id = ? AND ended_at IS NULL').all(regionId)
  ) as { id: number }[];
  return rows.map((r) => endAlert(r.id, reason)).filter(Boolean) as Alert[];
}

/** Alerts that never got an all-clear are closed after `alertMaxHours`. */
export function sweepAlerts() {
  const maxH = getSetting('limits').alertMaxHours;
  const rows = db
    .prepare('SELECT id FROM alerts WHERE ended_at IS NULL AND updated_at < ?')
    .all(Date.now() - maxH * HOUR) as { id: number }[];
  for (const r of rows) endAlert(r.id, 'timeout');
}
