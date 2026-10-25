import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is web/.
export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'shared') } },
  test: {
    root: '.',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
