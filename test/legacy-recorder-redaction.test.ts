import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  clearAllRoutes,
  clearR2,
  createLegacyRecorderTables,
  seedR2Object,
  seedRoute,
  serveThroughWorker,
  TEST_DOMAIN,
} from './helpers';

/**
 * The credential redaction, proved against the PERSISTED D1 row for each of the
 * four legacy per-feature recorders and BOTH of the columns that can carry a
 * credential — `query_string` and `referrer`.
 *
 * The unit matrix in `test/utils/unified-traffic.test.ts` pins the redaction
 * rules themselves. This suite pins the WIRING: that each recorder call site
 * passes the sanitised values, and that it does so AFTER the `...analyticsData`
 * spread, so a future `getAnalyticsData` field cannot silently clobber a
 * redaction.
 */

/** A magic-link landing page redirecting through a short link. */
const CREDENTIAL_REFERRER = 'https://idp.example/verify?token=LIVE-GRANT&utm_source=email';
const REDACTED_REFERRER = 'https://idp.example/verify?token=[redacted]&utm_source=email';
/** Campaign parameters must survive byte-identically — that is what these rows are for. */
const REQUEST_QUERY = '?token=LIVE-GRANT&utm_source=newsletter&utm_medium=email';
const REDACTED_QUERY = '?token=[redacted]&utm_source=newsletter&utm_medium=email';

interface RecordedRow {
  query_string: string | null;
  referrer: string | null;
}

async function readRow(table: string, column: string, value: string): Promise<RecordedRow | null> {
  return env.DB.prepare(
    `SELECT query_string, referrer FROM ${table} WHERE ${column} = ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(value)
    .first<RecordedRow>();
}

describe('legacy recorders never persist a credential', () => {
  beforeAll(async () => {
    await createLegacyRecorderTables();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    for (const table of ['link_clicks', 'file_downloads', 'proxy_requests', 'page_views']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('link_clicks: both columns are sanitised on a redirect', async () => {
    await seedRoute({
      path: '/rd-cred',
      type: 'redirect',
      target: 'https://target.example/landing',
      statusCode: 302,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await serveThroughWorker(`/rd-cred${REQUEST_QUERY}`, {
      referer: CREDENTIAL_REFERRER,
    });
    expect(response.status).toBe(302);

    const row = await readRow('link_clicks', 'slug', '/rd-cred');
    expect(row?.query_string).toBe(REDACTED_QUERY);
    expect(row?.referrer).toBe(REDACTED_REFERRER);
    expect(JSON.stringify(row)).not.toContain('LIVE-GRANT');
  });

  it('file_downloads: both columns are sanitised on an R2 serve', async () => {
    await seedR2Object('redaction/file.txt', 'abcdefghij', 'text/plain');
    await seedRoute({
      path: '/r2-cred',
      type: 'r2',
      target: 'redaction/file.txt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await serveThroughWorker(`/r2-cred${REQUEST_QUERY}`, {
      referer: CREDENTIAL_REFERRER,
    });
    expect(response.status).toBe(200);

    const row = await readRow('file_downloads', 'path', '/r2-cred');
    expect(row?.query_string).toBe(REDACTED_QUERY);
    expect(row?.referrer).toBe(REDACTED_REFERRER);
    expect(JSON.stringify(row)).not.toContain('LIVE-GRANT');
  });

  it('proxy_requests: both columns are sanitised on a proxied request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('proxied', { headers: { 'Content-Type': 'text/plain' } })),
    );

    await seedRoute({
      path: '/px-cred',
      type: 'proxy',
      target: 'https://upstream.example/api',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await serveThroughWorker(`/px-cred${REQUEST_QUERY}`, {
      referer: CREDENTIAL_REFERRER,
    });
    expect(response.status).toBe(200);

    const row = await readRow('proxy_requests', 'path', '/px-cred');
    expect(row?.query_string).toBe(REDACTED_QUERY);
    expect(row?.referrer).toBe(REDACTED_REFERRER);
    expect(JSON.stringify(row)).not.toContain('LIVE-GRANT');
  });

  it('page_views: both columns are sanitised on the service-binding fallback', async () => {
    // `example.com` is the one domain with a service-binding fallback, and an
    // HTML response from it is what drives `recordPageView`.
    const bindings = env as unknown as Record<string, unknown>;
    const original = bindings.EXAMPLE_SITE;
    bindings.EXAMPLE_SITE = {
      fetch: async () =>
        new Response('<html lang="en"><body>hi</body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    };

    try {
      const response = await serveThroughWorker(
        `/no-route-here${REQUEST_QUERY}`,
        { referer: CREDENTIAL_REFERRER },
        TEST_DOMAIN,
      );
      expect(response.status).toBe(200);

      const row = await readRow('page_views', 'path', '/no-route-here');
      expect(row?.query_string).toBe(REDACTED_QUERY);
      expect(row?.referrer).toBe(REDACTED_REFERRER);
      expect(JSON.stringify(row)).not.toContain('LIVE-GRANT');
    } finally {
      bindings.EXAMPLE_SITE = original;
    }
  });

  it('keeps a wholly non-sensitive request byte-identical', async () => {
    await seedRoute({
      path: '/rd-clean',
      type: 'redirect',
      target: 'https://target.example/landing',
      statusCode: 302,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const query = '?utm_source=x&utm_medium=email&q=a%20b';
    await serveThroughWorker(`/rd-clean${query}`, {
      referer: 'https://news.example/issue-9?utm_source=x',
    });

    const row = await readRow('link_clicks', 'slug', '/rd-clean');
    expect(row?.query_string).toBe(query);
    expect(row?.referrer).toBe('https://news.example/issue-9?utm_source=x');
  });

  it('stores NULL for a request with no query string', async () => {
    await seedRoute({
      path: '/rd-bare',
      type: 'redirect',
      target: 'https://target.example/landing',
      statusCode: 302,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await serveThroughWorker('/rd-bare');

    const row = await readRow('link_clicks', 'slug', '/rd-bare');
    expect(row?.query_string).toBeNull();
  });
});
