import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import { shouldRecordFileDownload } from '../src/db/analytics';
import { clearAllRoutes, clearR2, seedR2Object, seedRoute, TEST_DOMAIN } from './helpers';

/**
 * End-to-end proof of the R2 serve path against a REAL R2 binding.
 *
 * Every other suite mocks `bucket.get`, which is exactly how the pre-release
 * `ETag: object.etag` bug survived review: the mocks quoted `etag` and
 * `httpEtag` identically, so an invalid unquoted entity-tag looked correct and
 * the 500-on-revalidation it caused was invisible. Miniflare's R2 returns the
 * real shapes — raw `etag`, quoted `httpEtag`, genuine `R2Range` values — so
 * these tests exercise the conditional/range contract as deployed.
 *
 * They also cover the `file_downloads` recorder gate. The recorder used to fire
 * on any `response.ok`; once the serve path honoured `Range` that became wrong
 * in two directions — a 206 is one slice of a file (a seeking media player
 * writes dozens of rows per view, each with `file_size` set to the slice and
 * `X-Cache-Status` permanently MISS), and a 304 transfers no bytes at all.
 */
function createExecutionContext(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    settled: async () => {
      await Promise.allSettled(pending);
    },
  };
}

async function countDownloads(path: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM file_downloads WHERE path = ?')
    .bind(path)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Serve `path` through the real worker and settle the recorder's waitUntil. */
async function serve(path: string, headers: HeadersInit = {}): Promise<Response> {
  const { ctx, settled } = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://${TEST_DOMAIN}${path}`, { headers }),
    env,
    ctx,
  );
  // Drain the body so the streamed R2 read completes before the assertions.
  await response.clone().arrayBuffer();
  await settled();
  return response;
}

describe('R2 serve path against a real R2 binding', () => {
  beforeAll(async () => {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS file_downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        domain TEXT NOT NULL,
        path TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        content_type TEXT,
        file_size INTEGER,
        query_string TEXT,
        referrer TEXT,
        user_agent TEXT,
        country TEXT,
        city TEXT,
        colo TEXT,
        continent TEXT,
        timezone TEXT,
        http_protocol TEXT,
        ip_address TEXT,
        cache_status TEXT,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL
      )
    `).run();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    await env.DB.prepare('DELETE FROM file_downloads').run();
  });

  async function seed(path: string, key: string, body = 'abcdefghij'): Promise<void> {
    await seedR2Object(key, body, 'text/plain');
    await seedRoute({
      path,
      type: 'r2',
      target: key,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it('records a download for a full 200', async () => {
    await seed('/rec-full', 'recorder/full.txt');

    const response = await serve('/rec-full');

    expect(response.status).toBe(200);
    expect(await countDownloads('/rec-full')).toBe(1);

    const row = await env.DB.prepare('SELECT r2_key, file_size FROM file_downloads WHERE path = ?')
      .bind('/rec-full')
      .first<{ r2_key: string; file_size: number }>();
    expect(row?.r2_key).toBe('recorder/full.txt');
    expect(row?.file_size).toBe(10);
  });

  it('serves a 206 with real R2 range values and records nothing', async () => {
    await seed('/rec-range', 'recorder/range.txt');

    const response = await serve('/rec-range', { Range: 'bytes=0-3' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-3/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(await response.text()).toBe('abcd');
    expect(await countDownloads('/rec-range')).toBe(0);
  });

  it('delivers exactly the bytes its Content-Length declares (real R2)', async () => {
    // The mock suites can declare a Content-Length that the mock body does not
    // honour. Against a real binding the two cannot disagree, so this is the
    // assertion that actually proves the arithmetic: a Content-Length larger
    // than the body hangs conforming clients on a truncated response.
    await seed('/rec-bytes', 'recorder/bytes.txt');

    for (const range of ['bytes=0-3', 'bytes=4-', 'bytes=-3', 'bytes=0-']) {
      const response = await serve('/rec-bytes', { Range: range });
      expect(response.status, `${range} should be partial`).toBe(206);
      const declared = Number(response.headers.get('Content-Length'));
      expect((await response.arrayBuffer()).byteLength, `${range} body length`).toBe(declared);

      // ...and the Content-Range arithmetic must agree with that same length.
      const [, first, last, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get('Content-Range') as string,
      ) as RegExpExecArray;
      expect(Number(last) - Number(first) + 1, `${range} Content-Range span`).toBe(declared);
      expect(Number(total)).toBe(10);
    }
  });

  it('resolves a real suffix range to absolute offsets', async () => {
    await seed('/rec-suffix', 'recorder/suffix.txt');

    const response = await serve('/rec-suffix', { Range: 'bytes=-3' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await response.text()).toBe('hij');
  });

  it('revalidates with the emitted entity-tag and records nothing for the 304', async () => {
    await seed('/rec-cond', 'recorder/cond.txt');

    // Learn the real etag from a first (recorded) serve, then revalidate.
    const first = await serve('/rec-cond');
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag');
    // Pins the quoted entity-tag form: an unquoted `object.etag` echoed back in
    // If-None-Match makes R2 throw, and the revalidation degrades to a full 200
    // (before the degraded read landed, it was a 500).
    expect(etag).toMatch(/^"[^"]+"$/);

    const revalidated = await serve('/rec-cond', { 'If-None-Match': etag as string });

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('ETag')).toBe(etag);
    expect(revalidated.headers.get('Last-Modified')).toBeTruthy();
    expect(await revalidated.text()).toBe('');
    // Still exactly the one row from the initial 200 — the 304 added none.
    expect(await countDownloads('/rec-cond')).toBe(1);
  });

  it('never 500s when a legacy client echoes back a raw unquoted validator', async () => {
    // The deploy-day case: every object stored before this release was served
    // with the RAW unquoted hash, so returning clients send it back verbatim
    // and R2 rejects the request outright. The degraded read must turn that
    // into a plain 200.
    await seed('/rec-legacy', 'recorder/legacy.txt');

    const first = await serve('/rec-legacy');
    const quoted = first.headers.get('ETag') as string;
    const rawEtag = quoted.replaceAll('"', '');

    const countBefore = await countDownloads('/rec-legacy');
    const response = await serve('/rec-legacy', { 'If-None-Match': rawEtag });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abcdefghij');
    // The degraded read serves a FULL 200, so it is a real download and IS
    // recorded. That is correct — and it is also the metric-inflation path: a
    // client repeating a malformed validator bypasses the edge cache and adds a
    // row every time. Pinned here so the behaviour is deliberate, not incidental.
    expect(await countDownloads('/rec-legacy')).toBe(countBefore + 1);
  });

  it('does not record a HEAD probe as a download (real worker)', async () => {
    await seed('/rec-head', 'recorder/head.txt');

    const { ctx, settled } = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://${TEST_DOMAIN}/rec-head`, { method: 'HEAD' }),
      env,
      ctx,
    );
    await settled();

    expect(response.status).toBe(200);
    expect(await countDownloads('/rec-head')).toBe(0);
  });

  it('returns 412 when a real If-Match precondition fails', async () => {
    await seed('/rec-412', 'recorder/412.txt');

    const response = await serve('/rec-412', { 'If-Match': '"not-the-stored-etag"' });

    expect(response.status).toBe(412);
    expect(await response.text()).toBe('');
    expect(await countDownloads('/rec-412')).toBe(0);
  });
});

describe('shouldRecordFileDownload (unit)', () => {
  it('records GET 200s for r2 routes', () => {
    expect(shouldRecordFileDownload({ type: 'r2' }, 200, 'GET')).toBe(true);
  });

  it('does NOT record 206s (per-slice row inflation)', () => {
    expect(shouldRecordFileDownload({ type: 'r2' }, 206, 'GET')).toBe(false);
  });

  it('does NOT record a HEAD probe (headers only, no bytes transferred)', () => {
    expect(shouldRecordFileDownload({ type: 'r2' }, 200, 'HEAD')).toBe(false);
  });

  it('does NOT record any other method', () => {
    // Only GET delivers a representation to a reader. Anything else reaching
    // this gate with a 200 is not a download.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(shouldRecordFileDownload({ type: 'r2' }, 200, method), method).toBe(false);
    }
  });

  it('never records 304s, 412s, or non-r2 routes', () => {
    expect(shouldRecordFileDownload({ type: 'r2' }, 304, 'GET')).toBe(false);
    expect(shouldRecordFileDownload({ type: 'r2' }, 412, 'GET')).toBe(false);
    expect(shouldRecordFileDownload({ type: 'redirect' }, 200, 'GET')).toBe(false);
    expect(shouldRecordFileDownload({ type: 'proxy' }, 200, 'GET')).toBe(false);
  });
});
