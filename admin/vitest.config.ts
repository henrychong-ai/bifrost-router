import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Vitest stubs CSS imports to empty strings by default. Process the
    // index.css file so `?raw` imports in tests resolve to the real source —
    // needed by `src/lib/typography.test.ts` (four-font stack regression suite).
    css: {
      include: [/index\.css/],
    },
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
