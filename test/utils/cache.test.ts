import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { purgeR2CacheForObject, purgeRouteUrl } from '../../src/utils/cache';
import { CLOUDFLARE_ZONE_IDS, R2_BUCKET_CUSTOM_DOMAINS } from '../../src/types';
import { clearAllRoutes, seedRoute } from '../helpers';

/**
 * This template ships `CLOUDFLARE_ZONE_IDS` and `R2_BUCKET_CUSTOM_DOMAINS`
 * EMPTY — a self-hoster fills them in with their own zone IDs and R2 custom
 * domains. With both empty every purge correctly degrades to `purged: 0`, so a
 * suite that did not populate them would assert nothing but the degrade path.
 * These hooks install a representative configuration and remove it again, so
 * the tests exercise the real purge arithmetic without changing the shipped
 * defaults.
 */
const TEST_ZONE_ID = 'test-zone-id';

// Snapshot and restore rather than delete: a bare `delete` would silently
// destroy a real entry if the shipped defaults ever stop being empty, and the
// loss would only show up as an unrelated suite failing later.
let zonesSnapshot: Record<string, string>;
let customDomainsSnapshot: Record<string, string[]>;

beforeAll(() => {
  zonesSnapshot = { ...CLOUDFLARE_ZONE_IDS };
  customDomainsSnapshot = { ...R2_BUCKET_CUSTOM_DOMAINS };
  CLOUDFLARE_ZONE_IDS['example.com'] = TEST_ZONE_ID;
  R2_BUCKET_CUSTOM_DOMAINS.files = ['files.example.com'];
});

afterAll(() => {
  for (const key of Object.keys(CLOUDFLARE_ZONE_IDS)) delete CLOUDFLARE_ZONE_IDS[key];
  Object.assign(CLOUDFLARE_ZONE_IDS, zonesSnapshot);
  for (const key of Object.keys(R2_BUCKET_CUSTOM_DOMAINS)) delete R2_BUCKET_CUSTOM_DOMAINS[key];
  Object.assign(R2_BUCKET_CUSTOM_DOMAINS, customDomainsSnapshot);
});

/** Bodies posted to the Cloudflare zone purge API during a test. */
let purgeBodies: { files: string[] }[] = [];

/** Stub `fetch` so the CF purge API is observed rather than called. */
function stubPurgeApi(body: unknown = { success: true }): void {
  purgeBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/purge_cache')) {
        purgeBodies.push(JSON.parse(String(init?.body ?? '{}')) as { files: string[] });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/**
 * `purgeRouteUrl` is the route-side complement of `purgeR2CacheForObject`: the
 * OBJECT is untouched but the route→object mapping changed, so the route's own
 * URL is what holds a stale body at the edge.
 */
describe('purgeRouteUrl', () => {
  beforeEach(() => {
    stubPurgeApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('zone-purges the route URL built from domain + path', async () => {
    const result = await purgeRouteUrl('links.example.com', '/report', 'test-token');

    expect(result.urls).toEqual(['https://links.example.com/report']);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);
    expect(purgeBodies).toEqual([{ files: ['https://links.example.com/report'] }]);
  });

  it('resolves a subdomain to its parent zone', async () => {
    const result = await purgeRouteUrl('deep.nested.example.com', '/deck', 'test-token');

    expect(result.purged).toBe(1);
    // The example.com zone, reached by walking up from the subdomain.
    const [call] = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(String(call[0])).toContain(TEST_ZONE_ID);
  });

  it('percent-encodes path segments so the purge matches the cached URL', async () => {
    // `normalizePath()` DECODES the stored path, but the cache entry lives under
    // the request URL, which is encoded. Purging the decoded form would miss it,
    // and Cloudflare rejects a batch containing a URL with raw spaces.
    const result = await purgeRouteUrl('links.example.com', '/my report (2026)', 'test-token');

    expect(result.urls).toEqual(['https://links.example.com/my%20report%20(2026)']);
    expect(purgeBodies).toEqual([{ files: ['https://links.example.com/my%20report%20(2026)'] }]);
    expect(result.purged).toBe(1);
  });

  it('preserves slashes as separators while encoding each segment', async () => {
    const result = await purgeRouteUrl('links.example.com', '/docs/q1 report', 'test-token');

    expect(result.urls).toEqual(['https://links.example.com/docs/q1%20report']);
  });

  it('leaves an already-safe path byte-identical', async () => {
    const result = await purgeRouteUrl('links.example.com', '/docs/report-2026', 'test-token');

    expect(result.urls).toEqual(['https://links.example.com/docs/report-2026']);
  });

  it('degrades to purged=0 without an API token instead of throwing', async () => {
    const result = await purgeRouteUrl('links.example.com', '/report');

    expect(result).toEqual({
      purged: 0,
      failed: 0,
      urls: ['https://links.example.com/report'],
    });
    // The CF API is never reached when the token is absent.
    expect(purgeBodies).toHaveLength(0);
  });

  it('degrades to purged=0 for a domain with no zone mapping', async () => {
    const result = await purgeRouteUrl('not-a-configured-zone.test', '/report', 'test-token');

    expect(result).toEqual({
      purged: 0,
      failed: 0,
      urls: ['https://not-a-configured-zone.test/report'],
    });
    expect(purgeBodies).toHaveLength(0);
  });

  it('reports a failure when the CF API returns success:false', async () => {
    stubPurgeApi({ success: false });

    const result = await purgeRouteUrl('links.example.com', '/report', 'test-token');

    expect(result.purged).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe('purgeR2CacheForObject', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    stubPurgeApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('purges the R2 custom-domain URL and every route pointing at the key', async () => {
    await seedRoute(
      {
        path: '/report',
        type: 'r2',
        target: 'docs/report.pdf',
        bucket: 'files',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      'links.example.com',
    );

    const result = await purgeR2CacheForObject(
      env.ROUTES,
      'files',
      'docs/report.pdf',
      'test-token',
    );

    expect(result.urls).toContain('https://links.example.com/report');
    expect(result.urls).toContain('https://files.example.com/docs/report.pdf');
    expect(result.failed).toBe(0);
  });

  it('percent-encodes route paths so one bad URL cannot fail the whole batch', async () => {
    // Cloudflare rejects a purge list containing a raw space, and the rejection
    // fails the ENTIRE batch — which would take the correctly-encoded
    // custom-domain URL down with it.
    await seedRoute(
      {
        path: '/q1 report',
        type: 'r2',
        target: 'docs/report.pdf',
        bucket: 'files',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      'example.com',
    );

    const result = await purgeR2CacheForObject(
      env.ROUTES,
      'files',
      'docs/report.pdf',
      'test-token',
    );

    expect(result.urls).toContain('https://example.com/q1%20report');
    expect(result.urls).not.toContain('https://example.com/q1 report');
    for (const body of purgeBodies) {
      for (const url of body.files) expect(url).not.toMatch(/ /);
    }
  });

  it('SKIPS a wildcard route URL but still purges the custom-domain URL', async () => {
    // Purge-by-URL does not expand `*`, so the wildcard entry would purge
    // nothing while occupying a slot in the batch. Dropping it must not cost
    // the object its real custom-domain purge.
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    await seedRoute(
      {
        path: '/assets/*',
        type: 'r2',
        target: 'docs/report.pdf',
        bucket: 'files',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      'example.com',
    );

    const result = await purgeR2CacheForObject(
      env.ROUTES,
      'files',
      'docs/report.pdf',
      'test-token',
    );

    expect(result.urls).not.toContain('https://example.com/assets/*');
    expect(result.urls).toContain('https://files.example.com/docs/report.pdf');
    expect(result.purged).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('purge not possible for wildcard route'))).toBe(true);
  });

  it('degrades to purged=0 without an API token', async () => {
    const result = await purgeR2CacheForObject(env.ROUTES, 'files', 'docs/report.pdf');

    expect(result.purged).toBe(0);
    expect(purgeBodies).toHaveLength(0);
  });
});
