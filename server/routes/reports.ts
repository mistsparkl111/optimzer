import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv } from '../auth';
import { db } from '../db';
import { body, fail } from '../util';
import { createReport, removeReport, voteReport } from '../services/reports';
import { REPORT_TYPES } from '../../shared/constants';

export const reportRoutes = new Hono<AppEnv>();

const newSchema = z.object({
  type: z.enum(REPORT_TYPES),
  lat: z.number().min(35).max(82),
  lon: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).nullable().optional(),
  count: z.number().int().min(1).max(500).nullable().optional(),
  comment: z.string().trim().max(140).nullable().optional(),
});

reportRoutes.post('/', async (c) => {
  const u = requireUser(c);
  const data = await body(c, newSchema);
  return c.json({ report: createReport(u, data) });
});

reportRoutes.post('/:id/vote', async (c) => {
  const u = requireUser(c);
  const { vote } = await body(c, z.object({ vote: z.union([z.literal(1), z.literal(-1)]) }));
  const report = voteReport(u, Number(c.req.param('id')), vote);
  return c.json({ report, removed: !report });
});

reportRoutes.delete('/:id', (c) => {
  const u = requireUser(c);
  const id = Number(c.req.param('id'));
  const r = db.prepare('SELECT user_id FROM reports WHERE id = ?').get(id) as { user_id: number } | undefined;
  if (!r) fail(404, 'Метка не найдена');
  if (r.user_id !== u.id && u.role === 'user') fail(403, 'Можно удалить только свою метку');
  removeReport(id);
  return c.json({ ok: true });
});
