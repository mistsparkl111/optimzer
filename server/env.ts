import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();

// .env is loaded without extra dependencies; variables already set in the environment win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn('[env] не удалось прочитать .env:', (e as Error).message);
  }
}

export const isProd = process.env.NODE_ENV === 'production';
// In dev, hosting/preview platforms assign PORT to the web (Vite) server, so the API uses its own API_PORT.
export const PORT = Number(process.env.API_PORT || (isProd ? process.env.PORT : '') || 8787);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret(): string {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, '.app-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  if (isProd) console.warn('[env] APP_SECRET не задан — сгенерирован и сохранён в', file);
  return secret;
}

export const APP_SECRET = loadSecret();
export const PUBLIC_URL = (process.env.PUBLIC_URL || (isProd ? `http://localhost:${PORT}` : 'http://localhost:5173')).replace(/\/$/, '');
/** Contact for Web Push (VAPID): mailto:… or https://… */
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT?.trim() || '';
export const DEMO_PAYMENTS = process.env.DEMO_PAYMENTS ? process.env.DEMO_PAYMENTS === '1' : !isProd;

export const WEB_DIST = path.join(ROOT, 'dist', 'web');
export const GEO_DIR = fs.existsSync(path.join(WEB_DIST, 'geo', 'russia.topo.json'))
  ? path.join(WEB_DIST, 'geo')
  : path.join(ROOT, 'web', 'public', 'geo');
