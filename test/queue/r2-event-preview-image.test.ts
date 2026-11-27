/**
 * v1.48.0: an object written directly in Cloudflare (an uncorrelated create,
 * recorded as an external `r2_object_create` row) bypasses the refusal of an
 * overwrite. The consumer records on that row whether a route shows the
 * object as its link-preview image and whether the route's stored pixel size
 * still matches, in fixed fields and counts only, and never loses or delays
 * the row for it.
 */

import { env } from 'cloudflare:test';
import { PREVIEW_DEFAULT_IMAGES, type PreviewImageRef } from '@bifrost/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoute } from '../../src/kv/routes';
import { _internal, handleR2EventBatch, type R2EventMessage } from '../../src/queue/r2-events';
import type { Bindings } from '../../src/types';
import { clearAllRoutes, clearR2 } from '../helpers';
import { pngBytes } from '../image-bytes';
import { usePreviewBuckets } from '../link-preview-config';

usePreviewBuckets();

const DDL = [
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    domain TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_login TEXT,
    actor_name TEXT,
    path TEXT,
    details TEXT,
    ip_address TEXT,
    source TEXT NOT NULL DEFAULT 'bifrost',
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS r2_event_correlations (
    audit_id INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    event_time INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (audit_id, event_kind)
  )`,
  `CREATE TABLE IF NOT EXISTS r2_event_seen (
    fingerprint TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
];

const IMAGE_KEY = 'previews/external-card.png';

/** The ETag of the last object `putImage` wrote: the events name it. */
let currentEtag = 'etag-external';

/** Put the image object, as the external write the event reports. */
async function putImage(value: Uint8Array | string): Promise<void> {
  currentEtag = (await env.ASSETS_BUCKET.put(IMAGE_KEY, value)).etag;
}

function event(overrides: Partial<R2EventMessage> = {}): R2EventMessage {
  return {
    account: 'test-account',
    action: 'PutObject',
    bucket: 'assets',
    object: { key: IMAGE_KEY, size: 2048, eTag: currentEtag },
    eventTime: new Date().toISOString(),
    ...overrides,
  };
}

function batchOf(events: R2EventMessage[]) {
  const messages = events.map((body, index) => ({
    id: `m-${index}`,
    attempts: 1,
    body,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  }));
  const batch = {
    queue: 'bifrost-r2-events',
    messages,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<R2EventMessage>;
  return { batch, messages };
}

function envWith(overrides: Record<string, unknown> = {}): Bindings {
  return { ...env, R2_EVENT_AUDIT: 'on', ...overrides } as Bindings;
}

/** The `previewImage` field of every recorded row, in order. */
async function recordedChecks(): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    'SELECT action, details FROM audit_logs ORDER BY id',
  ).all<{ action: string; details: string }>();
  return results.map(row => JSON.parse(row.details).previewImage);
}

/** A file route on links.example.com that shows the image, at a stored size. */
async function imageRoute(path: string, width = 1200, height = 630, bucket = 'assets') {
  await createRoute(env.ROUTES, 'links.example.com', {
    path,
    type: 'r2',
    target: 'briefings/external.pdf',
    bucket: 'files',
    previewTitle: 'Briefing',
    previewImageBucket: bucket,
    previewImageKey: IMAGE_KEY,
    previewImageWidth: width,
    previewImageHeight: height,
  });
}

async function run(events: R2EventMessage[], overrides: Record<string, unknown> = {}) {
  const { batch, messages } = batchOf(events);
  await handleR2EventBatch(batch, envWith(overrides));
  for (const message of messages) {
    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
  }
}

describe('an external create of a preview image (v1.48.0)', () => {
  beforeAll(async () => {
    for (const statement of DDL) await env.DB.prepare(statement).run();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    for (const { key } of (await env.ASSETS_BUCKET.list()).objects) {
      await env.ASSETS_BUCKET.delete(key);
    }
    await env.DB.prepare('DELETE FROM audit_logs').run();
    await env.DB.prepare('DELETE FROM r2_event_correlations').run();
    await env.DB.prepare('DELETE FROM r2_event_seen').run();
    currentEtag = 'etag-external';
  });

  afterEach(() => vi.restoreAllMocks());

  it('the same pixel size: the routes are counted, no size differs', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/briefing');
    await run([event()]);
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 1, defaults: 0, measured: true, sizeDiffers: 0, unsized: 0 },
    ]);
  });

  it('another pixel size: counts the routes whose stored size no longer matches', async () => {
    await putImage(pngBytes(400, 400));
    await imageRoute('/stale');
    await imageRoute('/remeasured', 400, 400);
    await run([event()]);
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 2, defaults: 0, measured: true, sizeDiffers: 1, unsized: 0 },
    ]);
  });

  it.each([
    ['not a JPEG or PNG', () => putImage('plain text')],
    ['over 600,000 bytes', () => putImage(new Uint8Array(600_001))],
    ['gone by the time of the check', async () => {}],
  ])('a new object that cannot be measured (%s): measured false', async (_label, put) => {
    await put();
    await imageRoute('/briefing');
    await run([event()]);
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 1, defaults: 0, measured: false },
    ]);
  });

  it('no route shows the object: routes 0, and no R2 read', async () => {
    await putImage(pngBytes(1200, 630));
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    await run([event()]);
    expect(await recordedChecks()).toEqual([{ checked: true, routes: 0, defaults: 0 }]);
    expect(get).not.toHaveBeenCalled();
  });

  it('a bucket that cannot hold a preview image: no field, no scan', async () => {
    const list = vi.spyOn(env.ROUTES, 'list');
    await run([
      // No custom domain, a development bucket name, the backup bucket
      event({ bucket: 'files-user1', object: { key: 'site/index.html', size: 10 } }),
      event({ bucket: 'assets-dev', object: { key: IMAGE_KEY, size: 10 } }),
      event({ bucket: 'bifrost-backups', object: { key: 'manual.sql', size: 1 } }),
    ]);
    expect(await recordedChecks()).toEqual([undefined, undefined, undefined]);
    expect(list).not.toHaveBeenCalled();
  });

  it('an event on another bucket is another object', async () => {
    await imageRoute('/briefing');
    await run([event({ bucket: 'files' })]);
    expect(await recordedChecks()).toEqual([{ checked: true, routes: 0, defaults: 0 }]);
  });

  it('one route scan per batch, shared by its events', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/briefing');
    const list = vi.spyOn(env.ROUTES, 'list');
    await run([
      event(),
      event({ object: { key: IMAGE_KEY, size: 2048, eTag: 'two' } }),
      event({ object: { key: 'previews/other.png', size: 10, eTag: 'three' } }),
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 1, defaults: 0, measured: true, sizeDiffers: 0, unsized: 0 },
      // Another ETag than the stored object's: that write was superseded
      { checked: true, routes: 1, defaults: 0, measured: false, superseded: true },
      { checked: true, routes: 0, defaults: 0 },
    ]);
  });

  it('two uploads to the key before consumption: the first row is superseded, never a match', async () => {
    await imageRoute('/briefing');
    // First external write (the route's own size), then a second, other size
    await putImage(pngBytes(1200, 630));
    const first = event({ eventTime: new Date(Date.now() - 2000).toISOString() });
    await putImage(pngBytes(400, 400));
    const second = event();
    await run([first, second]);
    expect(await recordedChecks()).toEqual([
      // The first event's object is gone: its row cannot say, rather than
      // reporting the second object's size as the first one's
      { checked: true, routes: 1, defaults: 0, measured: false, superseded: true },
      { checked: true, routes: 1, defaults: 0, measured: true, sizeDiffers: 1, unsized: 0 },
    ]);
  });

  it('an event with no ETag is not measured, and supersession is left unknown', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/briefing');
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    await run([event({ object: { key: IMAGE_KEY, size: 2048 } })]);
    // No `superseded` field: nothing shows the object changed
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 1, defaults: 0, measured: false },
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it('a feedback artifact event is never checked: the feedback bucket holds no preview image', async () => {
    const key = 'feedback/item-b/shot.png';
    await env.ROUTES.put(
      'links.example.com:/item-b',
      JSON.stringify({
        path: '/item-b',
        type: 'r2',
        target: 'briefings/external.pdf',
        bucket: 'files',
        previewTitle: 'Shot',
        previewImageBucket: 'assets',
        previewImageKey: key,
        previewImageWidth: 1200,
        previewImageHeight: 630,
      }),
    );
    const list = vi.spyOn(env.ROUTES, 'list');
    await run([event({ bucket: 'bifrost-feedback', action: 'DeleteObject', object: { key } })]);
    expect(await recordedChecks()).toEqual([undefined]);
    expect(list).not.toHaveBeenCalled();
  });

  it('a failed scan: the rows are recorded all the same, the check marked not run, no key logged', async () => {
    await imageRoute('/briefing');
    const list = vi
      .spyOn(env.ROUTES, 'list')
      .mockRejectedValue(new Error(`KV down at links.example.com:/briefing ${IMAGE_KEY}`));
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    await run([event(), event({ object: { key: IMAGE_KEY, size: 1, eTag: 'second' } })]);
    expect(await recordedChecks()).toEqual([{ checked: false }, { checked: false }]);
    // The failure is shared by the batch: one listing attempt, not one per event
    expect(list).toHaveBeenCalledTimes(1);
    for (const line of lines) {
      expect(line).not.toContain(IMAGE_KEY);
      expect(line).not.toContain('/briefing');
    }
    expect(lines.filter(line => line.includes('r2-event-preview-check-not-run'))).toEqual([
      JSON.stringify({
        level: 'warn',
        message: 'r2-event-preview-check-not-run',
        errorName: 'KVReadError',
        bucket: 'assets',
      }),
      JSON.stringify({
        level: 'warn',
        message: 'r2-event-preview-check-not-run',
        errorName: 'KVReadError',
        bucket: 'assets',
      }),
    ]);
  });

  it('a failed image read, or an unbound image bucket: marked not run, the row recorded', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/briefing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(env.ASSETS_BUCKET, 'get').mockRejectedValueOnce(new Error('R2 down'));
    await run([event()]);
    await run([event({ object: { key: IMAGE_KEY, size: 2048, eTag: 'unbound' } })], {
      ASSETS_BUCKET: undefined,
    });
    expect(await recordedChecks()).toEqual([{ checked: false }, { checked: false }]);
  });

  it('a create Bifrost made itself (correlated): no check, no scan', async () => {
    await imageRoute('/briefing');
    await env.DB.prepare(
      `INSERT INTO audit_logs (domain, action, actor_login, path, source)
       VALUES ('storage', 'r2_replace', 'someone', ?1, 'bifrost')`,
    )
      .bind(`assets/${IMAGE_KEY}`)
      .run();
    const list = vi.spyOn(env.ROUTES, 'list');
    await run([event()]);
    expect(list).not.toHaveBeenCalled();
    const { results } = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE source = 'r2_event'",
    ).all<{ action: string }>();
    expect(results).toEqual([]);
  });

  it('an external delete: the routes that now show a missing image are counted, no R2 read', async () => {
    await imageRoute('/briefing');
    await imageRoute('/second');
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    await run([
      event({ action: 'DeleteObject', object: { key: IMAGE_KEY } }),
      event({ action: 'DeleteObject', object: { key: 'previews/unused.png' } }),
    ]);
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 2, defaults: 0 },
      { checked: true, routes: 0, defaults: 0 },
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it('an external delete whose scan fails is recorded with checked false', async () => {
    await imageRoute('/briefing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(env.ROUTES, 'list').mockRejectedValue(new Error('KV down'));
    await run([event({ action: 'DeleteObject', object: { key: IMAGE_KEY } })]);
    expect(await recordedChecks()).toEqual([{ checked: false }]);
  });

  it('a route with no stored size is counted as unsized, never as differing', async () => {
    await putImage(pngBytes(400, 400));
    await imageRoute('/stale');
    await imageRoute('/unsized');
    const stored = JSON.parse((await env.ROUTES.get('links.example.com:/unsized')) ?? '{}');
    delete stored.previewImageWidth;
    delete stored.previewImageHeight;
    await env.ROUTES.put('links.example.com:/unsized', JSON.stringify(stored));
    await run([event()]);
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 2, defaults: 0, measured: true, sizeDiffers: 1, unsized: 1 },
    ]);
  });

  it('a redelivered event runs no scan and no R2 read: its row is a duplicate', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/briefing');
    const once = event();
    await run([once]);
    const list = vi.spyOn(env.ROUTES, 'list');
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    // The same event again (same fingerprint), in a new batch
    await run([{ ...once }]);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(await recordedChecks()).toEqual([
      { checked: true, routes: 1, defaults: 0, measured: true, sizeDiffers: 0, unsized: 0 },
    ]);
  });

  it('a fingerprint read that fails marks the check not run; the row is still recorded', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/briefing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await _internal.externalPreviewImageCheck(
      envWith(),
      {
        select: () => {
          throw new Error('D1 down');
        },
      } as never,
      'fp',
      event(),
      'create',
      _internal.lazyRouteScan(env.ROUTES),
    );
    expect(result).toEqual({ checked: false });
  });

  it('a create with a malformed event time is checked too', async () => {
    await putImage(pngBytes(400, 400));
    await imageRoute('/briefing');
    await run([event({ eventTime: 'not-a-time' })]);
    const { results } = await env.DB.prepare('SELECT details FROM audit_logs').all<{
      details: string;
    }>();
    expect(JSON.parse(results[0].details)).toMatchObject({
      malformedEventTime: true,
      previewImage: {
        checked: true,
        routes: 1,
        defaults: 0,
        measured: true,
        sizeDiffers: 1,
        unsized: 0,
      },
    });
  });

  it('the row holds fixed fields and counts only: no route path', async () => {
    await putImage(pngBytes(1200, 630));
    await imageRoute('/secret-briefing');
    await run([event()]);
    const { results } = await env.DB.prepare('SELECT details FROM audit_logs').all<{
      details: string;
    }>();
    expect(results[0].details).not.toContain('secret-briefing');
  });

  it('the batch scan is made lazily, once, and its failure is shared', async () => {
    const kv = {
      list: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('down')),
    } as unknown as KVNamespace;
    const scan = _internal.lazyRouteScan(kv);
    expect(kv.list).not.toHaveBeenCalled();
    await expect(scan()).rejects.toThrow('list:all');
    await expect(scan()).rejects.toThrow('list:all');
    expect(kv.list).toHaveBeenCalledTimes(1);
  });

  it("a domain's default card image is counted, never named", async () => {
    const defaults = PREVIEW_DEFAULT_IMAGES as Record<string, PreviewImageRef | null>;
    defaults['example.com'] = { bucket: 'assets', key: IMAGE_KEY, width: 1200, height: 630 };
    try {
      await putImage(pngBytes(1200, 630));
      await run([event(), event({ action: 'DeleteObject', object: { key: IMAGE_KEY } })]);
      expect(await recordedChecks()).toEqual([
        { checked: true, routes: 0, defaults: 1 },
        { checked: true, routes: 0, defaults: 1 },
      ]);
      const { results } = await env.DB.prepare('SELECT details FROM audit_logs').all<{
        details: string;
      }>();
      for (const row of results) expect(row.details).not.toContain('example.com');
    } finally {
      defaults['example.com'] = null;
    }
  });
});
