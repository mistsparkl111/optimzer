import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth';
import { db } from '../../db';
import { body, DAY, fail } from '../../util';
import { isRegionId } from '../../../shared/regions';
import { fetchRawPosts, getSource, listPosts, previewPosts, runSource, type SourceRow } from './ingest';
import { normalizeTelegramHandle } from './telegram';
import { normalizeFeedUrl } from './rss';

export { seedDefaultSources, startSourcePolling } from './ingest';

/** Admin-only routes mounted at /api/admin (paths /sources/*) */
export const adminSourceRoutes = new Hono<AppEnv>();

/* ---------- helpers ---------- */

type SourceType = SourceRow['type'];

function normalizeHandle(type: SourceType, raw: string): string {
  if (type === 'telegram') {
    const h = normalizeTelegramHandle(raw);
    if (!h) fail(400, 'handle: укажите канал в виде @name, t.me/name или https://t.me/s/name');
    return h;
  }
  const u = normalizeFeedUrl(raw);
  if (!u) fail(400, 'handle: укажите полный адрес RSS-ленты (http:// или https://)');
  return u;
}

interface SourceRowWithCount extends SourceRow {
  posts24h: number;
}

const toPublic = (r: SourceRowWithCount) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  handle: r.handle,
  lang: r.lang,
  kind: r.kind,
  side: r.side,
  regionId: r.region_id,
  autoAlerts: !!r.auto_alerts,
  trust: r.trust,
  enabled: !!r.enabled,
  pollSeconds: r.poll_seconds,
  lastFetchAt: r.last_fetch_at,
  lastError: r.last_error,
  lastPostAt: r.last_post_at,
  posts24h: r.posts24h,
});

const SELECT_WITH_COUNT = `SELECT s.*, (SELECT COUNT(*) FROM source_posts p WHERE p.source_id = s.id AND p.posted_at > ?) AS posts24h FROM sources s`;

function loadPublic(id: number) {
  const row = db.prepare(`${SELECT_WITH_COUNT} WHERE s.id = ?`).get(Date.now() - DAY, id) as SourceRowWithCount | undefined;
  return row ? toPublic(row) : null;
}

const regionField = z
  .string({ error: 'строка или null' })
  .nullable()
  .refine((v) => v === null || isRegionId(v), 'regionId: неизвестный регион');

const sourceFields = {
  name: z.string({ error: 'укажите название' }).trim().min(1, 'укажите название').max(80, 'не длиннее 80 символов'),
  type: z.enum(['telegram', 'rss'], { error: 'telegram или rss' }),
  handle: z.string({ error: 'укажите канал или адрес ленты' }).trim().min(1, 'укажите канал или адрес ленты').max(500, 'слишком длинный адрес'),
  lang: z.enum(['ru', 'uk', 'en'], { error: 'ru, uk или en' }),
  kind: z.enum(['official', 'monitoring', 'media', 'military'], { error: 'неизвестный тип источника' }),
  side: z.enum(['ru', 'ua', 'other'], { error: 'ru, ua или other' }),
  regionId: regionField,
  autoAlerts: z.boolean({ error: 'ожидается true или false' }),
  trust: z.number({ error: 'число от 0 до 1' }).min(0, 'от 0 до 1').max(1, 'от 0 до 1'),
  enabled: z.boolean({ error: 'ожидается true или false' }),
  pollSeconds: z.number({ error: 'число секунд от 60 до 3600' }).int('целое число').min(60, 'от 60 до 3600').max(3600, 'от 60 до 3600'),
};

const createSchema = z.object({
  ...sourceFields,
  lang: sourceFields.lang.default('ru'),
  kind: sourceFields.kind.default('media'),
  side: sourceFields.side.default('ru'),
  regionId: regionField.default(null),
  autoAlerts: sourceFields.autoAlerts.default(false),
  trust: sourceFields.trust.default(0.5),
  enabled: sourceFields.enabled.default(true),
  pollSeconds: sourceFields.pollSeconds.default(300),
});
const patchSchema = z.object(sourceFields).partial();

function idParam(c: { req: { param: (k: string) => string } }): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) fail(404, 'Источник не найден');
  return id;
}

/* ---------- routes ---------- */

adminSourceRoutes.get('/sources', (c) => {
  const rows = db.prepare(`${SELECT_WITH_COUNT} ORDER BY s.enabled DESC, s.name COLLATE NOCASE`).all(Date.now() - DAY) as SourceRowWithCount[];
  return c.json({ sources: rows.map(toPublic) });
});

adminSourceRoutes.post('/sources', async (c) => {
  const d = await body(c, createSchema);
  const handle = normalizeHandle(d.type, d.handle);
  const info = db
    .prepare(
      `INSERT INTO sources (name, type, handle, lang, kind, side, region_id, auto_alerts, trust, enabled, poll_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(d.name, d.type, handle, d.lang, d.kind, d.side, d.regionId, d.autoAlerts ? 1 : 0, d.trust, d.enabled ? 1 : 0, d.pollSeconds, Date.now());
  const id = Number(info.lastInsertRowid);
  if (d.enabled) void runSource(getSource(id)!);
  return c.json({ source: loadPublic(id) });
});

// Registered before the `:id` routes so that "preview" and "posts" are not treated as ids.
adminSourceRoutes.post('/sources/preview', async (c) => {
  const d = await body(c, z.object({ type: sourceFields.type, handle: sourceFields.handle }));
  const handle = normalizeHandle(d.type, d.handle);
  try {
    return c.json({ posts: previewPosts(await fetchRawPosts(d.type, handle), 10) });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : 'Не удалось загрузить источник');
  }
});

adminSourceRoutes.get('/sources/posts', (c) => {
  const sourceId = Number(c.req.query('sourceId')) || undefined;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  return c.json({ posts: listPosts({ sourceId, limit }) });
});

adminSourceRoutes.patch('/sources/:id', async (c) => {
  const id = idParam(c);
  const cur = getSource(id);
  if (!cur) fail(404, 'Источник не найден');
  const d = await body(c, patchSchema);
  const type = d.type ?? cur.type;
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v));
  if (d.name !== undefined) set('name', d.name);
  if (d.type !== undefined) set('type', d.type);
  if (d.handle !== undefined || d.type !== undefined) set('handle', normalizeHandle(type, d.handle ?? cur.handle));
  if (d.lang !== undefined) set('lang', d.lang);
  if (d.kind !== undefined) set('kind', d.kind);
  if (d.side !== undefined) set('side', d.side);
  if (d.regionId !== undefined) set('region_id', d.regionId);
  if (d.autoAlerts !== undefined) set('auto_alerts', d.autoAlerts ? 1 : 0);
  if (d.trust !== undefined) set('trust', d.trust);
  if (d.enabled !== undefined) set('enabled', d.enabled ? 1 : 0);
  if (d.pollSeconds !== undefined) set('poll_seconds', d.pollSeconds);
  // A changed address invalidates the previous fetch state.
  if (d.handle !== undefined || d.type !== undefined) (set('last_error', null), set('last_fetch_at', null));
  if (sets.length) db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return c.json({ source: loadPublic(id) });
});

adminSourceRoutes.delete('/sources/:id', (c) => {
  const id = idParam(c);
  const res = db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  if (!res.changes) fail(404, 'Источник не найден');
  return c.json({ ok: true });
});

adminSourceRoutes.post('/sources/:id/fetch', async (c) => {
  const id = idParam(c);
  const source = getSource(id);
  if (!source) fail(404, 'Источник не найден');
  const res = await runSource(source);
  if (res.error) fail(502, res.error);
  return c.json({ added: res.added, posts: listPosts({ sourceId: id, limit: 10 }) });
});
