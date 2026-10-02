import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { unstable_readConfig } from 'wrangler';

// The compatibility date and flags come from the DEPLOYED config, never from
// this file, so a test cannot pass on runtime behaviour production lacks. Only
// those two settings are read: pointing the pool at `wrangler.toml` wholesale
// would pull in every production binding and variable.
//
// ⚠️ One difference cannot be closed here. The pool force-enables Node.js
// compatibility on its own runner (the test framework needs it inside workerd),
// and the Worker under test shares that runner — so a `node:` import or a
// `process`/`Buffer` read in `src/` passes here whatever the flags say. What
// keeps Node APIs out of the Worker is the Wrangler build: with no
// `nodejs_compat` in `wrangler.toml`, `pnpm run wrangler:check` (part of
// `pnpm check` and CI) fails on a `node:` import.
const wranglerConfig = unstable_readConfig({
  config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
});
if (!wranglerConfig.compatibility_date) {
  throw new Error('wrangler.toml declares no compatibility_date for the test pool to use');
}

export default defineConfig({
  // vitest-pool-workers 0.18 (vitest 4): workers options moved from
  // test.poolOptions.workers to the cloudflareTest() plugin. The old
  // singleWorker/isolatedStorage options were removed upstream — isolation is
  // now per test FILE (vitest's own model), and each file gets its own worker.
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: wranglerConfig.compatibility_date,
        compatibilityFlags: wranglerConfig.compatibility_flags,
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
    // The explicit list REPLACES vitest's defaults, so nested node_modules and
    // the coding harness's isolated worktrees under `.claude/worktrees/` must
    // be named too — a sibling checkout there drags a dependency's own test
    // sources into this pool and crashes it.
    exclude: [
      'node_modules',
      '**/node_modules/**',
      '.claude/worktrees/**',
      'admin',
      'shared',
      'mcp',
      'slackbot',
      'scripts',
    ],
    // `vitest bench <file>` filters by SUBSTRING, so a sibling worktree's copy
    // of a bench file matches too and doubles the measurement count the routing
    // gate asserts on. Benchmarks have their own exclude list.
    benchmark: {
      exclude: [
        // vitest's own defaults, restored — naming an exclude list REPLACES
        // them, so dropping these would sweep build output and tool caches.
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '.claude/worktrees/**',
        'admin/**',
        'shared/**',
        'mcp/**',
        'slackbot/**',
      ],
    },
    coverage: {
      // The Workers pool runs in workerd, which does not expose V8's inspector
      // coverage API. Cloudflare requires instrumented Istanbul coverage here.
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        '**/node_modules/**',
        '**/dist/**',
        '.claude/worktrees/**',
        'admin/**',
        'shared/**',
        'mcp/**',
        'slackbot/**',
        'test/**',
        '**/*.test.ts',
        'vitest.config.ts',
      ],
      thresholds: {
        'src/utils/credential-redaction.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        statements: 69,
        branches: 58,
        functions: 67,
        lines: 70,
      },
    },
  },
});
