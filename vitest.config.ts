import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: './src/index.ts',
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            ENVIRONMENT: 'development',
            ADMIN_API_KEY: 'test-api-key-12345',
          },
          kvNamespaces: ['ROUTES'],
          r2Buckets: ['FILES_BUCKET'],
          d1Databases: ['DB'],
        },
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'test/**',
        '**/*.test.ts',
        'vitest.config.ts',
      ],
    },
  },
});
