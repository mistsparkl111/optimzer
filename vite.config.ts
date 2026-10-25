import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'shared') } },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: 'http://localhost:8787' } },
  },
  preview: { port: 5173, proxy: { '/api': { target: 'http://localhost:8787' } } },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
