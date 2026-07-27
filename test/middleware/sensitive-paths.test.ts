import { describe, it, expect, beforeEach } from 'vitest';
import { makeRequest, clearAllRoutes } from '../helpers';

describe('sensitive-paths middleware', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  const deniedExact = [
    '/wrangler.toml',
    '/package.json',
    '/pnpm-lock.yaml',
    '/tsconfig.json',
    '/biome.json',
    '/oxlint.json',
    '/Dockerfile',
    '/.DS_Store',
  ];

  const deniedPrefixes = [
    '/src/index.ts',
    '/test/helpers.ts',
    '/node_modules/anything',
    '/.git/HEAD',
    '/.svn/entries',
    '/.aws/credentials',
    '/.ssh/id_rsa',
    '/_next/static/foo.js',
  ];

  for (const path of deniedExact) {
    it(`returns 404 for exact-match denied path: ${path}`, async () => {
      const response = await makeRequest(path);
      expect(response.status).toBe(404);
    });
  }

  for (const path of deniedPrefixes) {
    it(`returns 404 for prefix-match denied path: ${path}`, async () => {
      const response = await makeRequest(path);
      expect(response.status).toBe(404);
    });
  }

  // Case-insensitive denial — scanners commonly probe both `/wrangler.toml`
  // and `/WRANGLER.TOML`. The middleware lower-cases the path before matching.
  const caseVariants = ['/WRANGLER.TOML', '/Package.json', '/.GIT/HEAD', '/Src/index.ts'];

  for (const path of caseVariants) {
    it(`returns 404 for case-variant denied path: ${path}`, async () => {
      const response = await makeRequest(path);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: string; hint?: string };
      // Deny-middleware 404 has no `hint` field, distinguishing it from the
      // KV catch-all's 404. Confirms the case-variant was caught here, not
      // by falling through to the KV lookup.
      expect(body.error).toBe('Not Found');
      expect(body.hint).toBeUndefined();
    });
  }

  // Paths that LOOK suspicious but are deliberately allowed through to KV
  // because operators may legitimately register them as redirects.
  const allowedThrough = ['/docs', '/admin', '/backup', '/swagger', '/openapi.json'];

  for (const path of allowedThrough) {
    it(`does not deny user-facing path: ${path}`, async () => {
      const response = await makeRequest(path);
      // No KV route registered, so we expect the standard 404 from the
      // catch-all KV-lookup branch — NOT a 404 from this middleware. Both
      // statuses are 404, so we just assert the path is reachable past the
      // deny middleware (response was generated, not blocked).
      expect(response.status).toBe(404);
      const body = (await response.json()) as { hint?: string };
      // The KV-lookup 404 includes a `hint` field; the deny middleware does not.
      expect(body.hint).toBeDefined();
    });
  }

  // Query-string path-traversal guard (admin host) — the query-only LFI class. makeRequest
  // uses http://localhost, which the guard treats as an admin host, so it fires.
  const traversalQueries = [
    '/probe?file=../../../etc/passwd',
    '/probe?file=..%2f..%2f..%2fetc%2fpasswd',
    '/probe?file=%2e%2e%2f%2e%2e%2fetc',
  ];

  for (const path of traversalQueries) {
    it(`returns 404 for query-string traversal: ${path}`, async () => {
      const response = await makeRequest(path);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { hint?: string };
      // Guard 404 has no `hint`, distinguishing it from the KV catch-all 404.
      expect(body.hint).toBeUndefined();
    });
  }

  it('allows a legit (non-traversal) query string through to KV', async () => {
    const response = await makeRequest('/probe?q=hello%20world');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { hint?: string };
    // Reached the KV catch-all (hint present) — the guard did not fire.
    expect(body.hint).toBeDefined();
  });
});
