// Bundles the API server into dist/server/index.js (npm packages stay external).
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts', 'server/cli/admin.ts'],
  outdir: 'dist/server',
  outbase: 'server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
