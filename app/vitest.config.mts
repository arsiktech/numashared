import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The app's own config, so vitest does not pick up the repository root config (Convex tests).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'plugins/**/*.test.mjs'],
  },
});
