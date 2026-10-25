import { db } from '../../db';
import { DAY, MIN } from '../../util';
import { endRegionAlerts, startAlert } from '../alerts';
import type { AlertType } from '../../../shared/constants';
import { isRegionId } from '../../../shared/regions';
import { parseSignals, readSignals, type PostSignals, type SignalThreat } from './parse';
import { fetchTelegram, type RawPost } from './telegram';
import { fetchRss } from './rss';

export interface SourceRow {
  id: number;
  name: string;
  type: 'telegram' | 'rss';
  handle: string;
  lang: 'ru' | 'uk' | 'en';
  kind: 'official' | 'monitoring' | 'media' | 'military';
  side: 'ru' | 'ua' | 'other';
  region_id: string | null;
  auto_alerts: number;
  trust: number;
  enabled: number;
  poll_seconds: number;
  last_fetch_at: number | null;
  last_error: string | null;
  last_post_at: number | null;
  created_at: number;
}

export interface PostPreview {
  id?: number;
  sourceId?: number;
  sourceName?: string;
  url: string | null;
  text: string;
  postedAt: number;
  signals: PostSignals;
}

export const AUTO_ALERT_MAX_AGE = 30 * MIN;
const POST_RETENTION = 14 * DAY;
const MAX_CONCURRENT = 3;

export function fetchRawPosts(type: SourceRow['type'], handle: string): Promise<RawPost[]> {
  return type === 'telegram' ? fetchTelegram(handle) : fetchRss(handle);
}

export const previewPosts = (raw: RawPost[], limit = 10): PostPreview[] =>
  [...raw]
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, limit)
    .map((p) => ({ url: p.url, text: p.text, postedAt: p.postedAt, signals: parseSignals(p.text) }));

/* ---------- concurrency ---------- */

let active = 0;
const waiters: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/* ---------- auto alerts ---------- */

/** Specific threat types win over the generic ones; explosions alone become "other". */
function alertTypes(threats: SignalThreat[]): AlertType[] {
  const specific = threats.filter((t): t is 'uav' | 'missile' | 'aviation' => t === 'uav' || t === 'missile' || t === 'aviation');
  if (specific.length) return specific;
  if (threats.includes('air')) return ['air'];
  if (threats.includes('explosion')) return ['other'];
  return [];
}

export function applyAutoAlerts(source: SourceRow, postId: number, post: RawPost, signals: PostSignals, now = Date.now()) {
  // Disabled sources may still be fetched manually (to verify them) but must not raise alerts.
  if (!source.enabled || !source.auto_alerts || source.kind !== 'official') return;
  if (now - post.postedAt > AUTO_ALERT_MAX_AGE) return;
  const targets = (
    source.region_id ? [source.region_id] : signals.regions.length >= 1 && signals.regions.length <= 3 ? signals.regions : []
  ).filter(isRegionId);
  if (!targets.length) return;

  if (signals.allClear) {
    for (const regionId of targets) endRegionAlerts(regionId, 'allclear', source.id);
    return;
  }
  if (!signals.isThreatNotice) return;
  const types = alertTypes(signals.threats);
  const message = post.text.replace(/\s+/g, ' ').trim().slice(0, 200);
  for (const regionId of targets) {
    for (const type of types) {
      startAlert({ regionId, type, source: 'source', sourceId: source.id, sourcePostId: postId, message, at: post.postedAt });
    }
  }
}

/* ---------- ingest ---------- */

export interface IngestResult {
  added: number;
  error: string | null;
}

const insertPost = db.prepare(
  `INSERT OR IGNORE INTO source_posts (source_id, external_id, url, text, posted_at, fetched_at, signals) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

export function ingestPosts(source: SourceRow, raw: RawPost[], now = Date.now()): number {
  const fresh: { id: number; post: RawPost; signals: PostSignals }[] = [];
  db.transaction(() => {
    for (const p of raw) {
      const signals = parseSignals(p.text);
      const res = insertPost.run(source.id, p.externalId, p.url, p.text.slice(0, 4000), p.postedAt, now, JSON.stringify(signals));
      if (res.changes) fresh.push({ id: Number(res.lastInsertRowid), post: p, signals });
    }
  })();
  // Oldest first so an "отбой" after a "тревога" ends the alert it just created.
  for (const f of fresh.sort((a, b) => a.post.postedAt - b.post.postedAt)) {
    try {
      applyAutoAlerts(source, f.id, f.post, f.signals, now);
    } catch (e) {
      console.error('[sources] auto-alert', source.name, e);
    }
  }
  return fresh.length;
}

const inFlight = new Map<number, Promise<IngestResult>>();

export function runSource(source: SourceRow): Promise<IngestResult> {
  const running = inFlight.get(source.id);
  if (running) return running;
  const p = limited(async (): Promise<IngestResult> => {
    const t = Date.now();
    try {
      const raw = await fetchRawPosts(source.type, source.handle);
      const added = ingestPosts(source, raw, t);
      const lastPost = raw.reduce((m, r) => Math.max(m, r.postedAt), 0);
      db.prepare('UPDATE sources SET last_fetch_at = ?, last_error = NULL, last_post_at = MAX(COALESCE(last_post_at, 0), ?) WHERE id = ?').run(
        t,
        lastPost,
        source.id,
      );
      return { added, error: null };
    } catch (e) {
      const error = (e instanceof Error ? e.message : 'Ошибка загрузки').slice(0, 300);
      db.prepare('UPDATE sources SET last_fetch_at = ?, last_error = ? WHERE id = ?').run(t, error, source.id);
      return { added: 0, error };
    }
  }).finally(() => inFlight.delete(source.id));
  inFlight.set(source.id, p);
  return p;
}

export const getSource = (id: number) => db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;

/* ---------- queries ---------- */

interface PostRow {
  id: number;
  source_id: number;
  source_name: string;
  url: string | null;
  text: string;
  posted_at: number;
  signals: string;
}

export function listPosts(opts: { sourceId?: number; limit?: number }): PostPreview[] {
  const rows = (
    opts.sourceId
      ? db
          .prepare(
            `SELECT p.*, s.name AS source_name FROM source_posts p JOIN sources s ON s.id = p.source_id WHERE p.source_id = ? ORDER BY p.posted_at DESC, p.id DESC LIMIT ?`,
          )
          .all(opts.sourceId, opts.limit ?? 50)
      : db
          .prepare(`SELECT p.*, s.name AS source_name FROM source_posts p JOIN sources s ON s.id = p.source_id ORDER BY p.posted_at DESC, p.id DESC LIMIT ?`)
          .all(opts.limit ?? 50)
  ) as PostRow[];
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    url: r.url,
    text: r.text,
    postedAt: r.posted_at,
    signals: readSignals(r.signals),
  }));
}

/* ---------- scheduler ---------- */

export function pollDueSources(now = Date.now()) {
  const due = db
    .prepare('SELECT * FROM sources WHERE enabled = 1 AND (last_fetch_at IS NULL OR last_fetch_at + poll_seconds * 1000 <= ?)')
    .all(now) as SourceRow[];
  for (const s of due) {
    if (inFlight.has(s.id)) continue;
    runSource(s).catch((e) => console.error('[sources]', s.name, e));
  }
}

export function cleanupOldPosts(now = Date.now()) {
  const res = db.prepare('DELETE FROM source_posts WHERE posted_at < ?').run(now - POST_RETENTION);
  if (res.changes) console.log(`[sources] удалено старых постов: ${res.changes}`);
}

export function startSourcePolling() {
  const guard = (name: string, fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      console.error(`[sources] ${name}`, e);
    }
  };
  setInterval(guard('poll', () => pollDueSources()), 15_000).unref();
  setTimeout(guard('poll', () => pollDueSources()), 3_000).unref();
  setTimeout(guard('cleanup', () => cleanupOldPosts()), 60_000).unref();
  setInterval(guard('cleanup', () => cleanupOldPosts()), DAY).unref();
}

export function seedDefaultSources() {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n;
  if (n) return;
  const ins = db.prepare(
    `INSERT INTO sources (name, type, handle, lang, kind, side, region_id, auto_alerts, trust, enabled, poll_seconds, created_at)
     VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  const t = Date.now();
  const rows: [string, string, string, string, string, string | null, number, number, number][] = [
    ['Минобороны России', 'mod_russia', 'ru', 'military', 'ru', null, 0, 0.7, 300],
    ['МЧС России', 'mchs_official', 'ru', 'official', 'ru', null, 0, 0.9, 300],
    ['Губернатор Белгородской области', 'vvgladkov', 'ru', 'official', 'ru', 'BEL', 1, 0.9, 120],
    ['Повітряні сили ЗСУ', 'kpszsu', 'uk', 'military', 'ua', null, 0, 0.7, 120],
  ];
  db.transaction(() => {
    for (const r of rows) ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], t);
  })();
  console.log('[sources] добавлены примеры источников (отключены) — проверьте и включите в админ-панели');
}

