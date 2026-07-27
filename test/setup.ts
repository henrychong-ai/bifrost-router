import { afterAll, vi } from 'vitest';

/**
 * Per-file stub/spy hygiene for the Cloudflare Workers pool.
 *
 * Under vitest-pool-workers <=0.12 the pool isolated storage and state per
 * TEST. From 0.13+ (vitest 4) that per-test rollback is gone — isolation is
 * per test FILE, and each file gets its own worker. Cross-file leaks are
 * therefore structurally impossible, but stubs and spies created inside a file
 * now persist across the tests within it.
 *
 * setupFiles run per test file, so this registers a per-file afterAll hook to
 * restore globals and mocks at file end.
 */
// eslint-disable-next-line jest/require-top-level-describe -- setup file: a per-file afterAll hook (not a test) is the intended use of setupFiles
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
