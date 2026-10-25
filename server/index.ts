import { serve } from '@hono/node-server';
import { isProd, PORT } from './env';
import { app } from './app';
import { syncLeaderRole } from './users';
import { initPush } from './services/push';
import { sweepAlerts } from './services/alerts';
import { sweepReports } from './services/reports';
import { scheduleFrontRefresh } from './services/front';
import { startForecastScheduler } from './services/ai';
import { seedDefaultSources, startSourcePolling } from './services/sources';

syncLeaderRole();
initPush();
seedDefaultSources();
setInterval(() => {
  try {
    sweepReports();
    sweepAlerts();
  } catch (e) {
    console.error('[sweep]', e);
  }
}, 10_000).unref();
scheduleFrontRefresh();
startSourcePolling();
startForecastScheduler();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[radar] API on http://localhost:${info.port} (${isProd ? 'production' : 'development'})`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[radar] Порт ${PORT} уже занят другой программой — API не запущен.\n` +
        `        Освободите порт или укажите другой: API_PORT=8790 npm run dev (или строкой API_PORT=8790 в .env).\n`,
    );
  } else {
    console.error('[radar] Не удалось запустить API:', err);
  }
  process.exit(1);
});
