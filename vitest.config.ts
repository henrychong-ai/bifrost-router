import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest-pool-workers 0.18 (vitest 4): workers options moved from
  // test.poolOptions.workers to the cloudflareTest() plugin. The old
  // singleWorker/isolatedStorage options were removed upstream — isolation is
  // now per test FILE (vitest's own model), and each file gets its own worker.
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          ENVIRONMENT: 'development',
          ADMIN_API_KEY: 'test-api-key-12345', // gitleaks:allow
          R2_COPY_SIZE_LIMIT_MB: '0.001',
        },
        kvNamespaces: ['ROUTES'],
        r2Buckets: ['FILES_BUCKET', 'ASSETS_BUCKET', 'BACKUP_BUCKET', 'FEEDBACK_BUCKET'],
        d1Databases: ['DB'],
      },
    }),
  ],
  test: {
    // Per-file afterAll restores stubbed globals + spies (intra-file stub
    // hygiene; cross-file leaks are structurally gone under per-file workers).
    setupFiles: ['./test/setup.ts'],
    exclude: ['node_modules', 'admin', 'shared', 'mcp', 'slackbot'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'test/**', '**/*.test.ts', 'vitest.config.ts'],
    },
  },
});
