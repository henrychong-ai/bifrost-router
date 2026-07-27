import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest-pool-workers 0.18 (vitest 4): workers options moved from
  // test.poolOptions.workers to the cloudflareTest() plugin.
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        kvNamespaces: ['SLACK_PERMISSIONS'],
        d1Databases: ['DB'],
      },
    }),
  ],
  test: {},
});
