import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Vitest stubs CSS imports to empty strings by default. Process the
    // index.css file so `?raw` imports in tests resolve to the real source —
    // needed by `src/lib/typography.test.ts` (four-font stack regression suite).
    css: {
      include: [/index\.css/],
    },
    coverage: {
      provider: 'v8',
      // filter-types.ts is included so the value-parity suite is instrumented —
      // without it that file carries no coverage mapping at all, and the
      // changed-line gate can only emit an unactionable "zero executable
      // coverage mapping" failure on it. Scoped to that one module rather than
      // all of src/context: the providers and hooks there are exercised through
      // the pages, not directly, and pulling them in would drop the LOCKED
      // floors below their configured level.
      include: ['src/lib/**/*.ts', 'src/context/filter-types.ts', 'src/pages/dashboard.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.fixture.ts'],
      thresholds: { statements: 43, branches: 49, functions: 31, lines: 44 },
    },
  },
});
