import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { WEB_DIST } from './env';
import { loadUser, requireRole, sameOrigin, type AppEnv } from './auth';
import { adminAiRoutes, aiRoutes } from './services/ai';
import { adminSourceRoutes } from './services/sources';
import { publicRoutes } from './routes/public';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { reportRoutes } from './routes/reports';
import { pushRoutes } from './routes/push';
import { billingRoutes } from './routes/billing';
import { adminRoutes } from './routes/admin';

export const app = new Hono<AppEnv>();

app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use('/api/*', sameOrigin, loadUser);
app.use('/api/admin/front', bodyLimit({ maxSize: 30 * 1024 * 1024 }));
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/admin/front') return next();
  return bodyLimit({ maxSize: 256 * 1024 })(c, next);
});

app.get('/api/health', (c) => c.json({ ok: true, time: Date.now() }));
app.route('/api', publicRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);
app.route('/api/reports', reportRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/admin', adminRoutes);
const adminOnly = new Hono<AppEnv>();
adminOnly.use('*', requireRole('admin'));
adminOnly.route('/', adminAiRoutes);
adminOnly.route('/', adminSourceRoutes);
app.route('/api/admin', adminOnly);

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error('[api]', c.req.method, c.req.path, err);
  return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
});

if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  const indexHtml = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/sw.js', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-cache');
  });
  app.use('*', serveStatic({ root: path.relative(process.cwd(), WEB_DIST) || '.' }));
  app.get('*', (c) => c.html(indexHtml));
}
