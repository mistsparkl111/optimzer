import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { ServerResponse } from 'node:http';

export default defineConfig(({ mode }) => {
  // Read the repo-root .env (the Vite root is web/).
  const env = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env };
  const apiPort = Number(env.API_PORT || 8787);
  const api = {
    target: `http://127.0.0.1:${apiPort}`,
    configure: (proxy: { on: (ev: 'error', fn: (err: Error, req: unknown, res: unknown) => void) => void }) => {
      // Readable JSON instead of an empty 502 while the API is (re)starting.
      proxy.on('error', (_err, _req, res) => {
        const r = res as ServerResponse;
        if (typeof r?.writeHead !== 'function' || r.headersSent || r.writableEnded) return;
        r.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        r.end(JSON.stringify({ error: `API-сервер не отвечает (порт ${apiPort}). Он запускается или упал — смотрите строки [api] в терминале.` }));
      });
    },
  };
  return {
    root: 'web',
    publicDir: 'public',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'shared') } },
    server: {
      port: Number(env.PORT) || 5173,
      host: true,
      // Dev server only: allow preview proxies and tunnels (ngrok, cloudflared) to test on a phone.
      allowedHosts: true,
      proxy: { '/api': api },
    },
    preview: { port: 5173, proxy: { '/api': api } },
    build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  };
});
