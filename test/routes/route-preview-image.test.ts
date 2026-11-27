/**
 * The preview image (v1.48.0) on its own (`measurePreviewImage`: unknown,
 * unconfigured and unbound buckets, one `get` with no `head`, an oversized
 * body cancelled unread), and the refusal of every storage write that would
 * leave a route's or a domain default's preview image stale or missing: an
 * overwrite, a delete, and a rename or move of the source. Rename, move and
 * new-key uploads are create-only. Driven through the real admin router.
 */

import { env } from 'cloudflare:test';
import {
  PREVIEW_DEFAULT_IMAGES,
  PREVIEW_IMAGE_MAX_BYTES,
  type PreviewImageRef,
} from '@bifrost/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoute } from '../../src/kv/routes';
import { adminRoutes } from '../../src/routes/admin';
import {
  mayHoldPreviewImage,
  measurePreviewImage,
  PREVIEW_DEFAULT_IMAGE_IN_USE_TEXT,
  PREVIEW_IMAGE_IN_USE_TEXT,
  PREVIEW_IMAGE_NOT_FOUND,
  PREVIEW_IMAGE_TOO_LARGE,
  PREVIEW_IMAGE_UNAVAILABLE,
  previewImageInUseMessage,
  previewImageSizeForWrite,
} from '../../src/routes/route-preview-image';
import type { AppEnv, Bindings } from '../../src/types';
import {
  clearAllRoutes,
  clearR2,
  createAuditLogsTable,
  createSettlingExecutionContext,
} from '../helpers';
import { pngBytes } from '../image-bytes';
import { usePreviewBuckets } from '../link-preview-config';

usePreviewBuckets();

const API_KEY = 'test-api-key-12345'; // gitleaks:allow
const DOMAIN = 'links.example.com';
const IMAGE_KEY = 'previews/briefing-card.png';
const IMAGE = pngBytes(1200, 630, 64);

interface Answer {
  success: boolean;
  error?: string;
  message?: string;
  code?: string;
  data?: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  body?: FormData | Record<string, unknown>,
  bindings: Partial<Bindings> = {},
): Promise<{ status: number; body: Answer }> {
  const { ctx, settled } = createSettlingExecutionContext();
  const isForm = body instanceof FormData;
  const response = await new Hono<AppEnv>().route('/api', adminRoutes).fetch(
    new Request(`http://bifrost.example.com/api${path}`, {
      method,
      headers: {
        'X-Admin-Key': API_KEY,
        ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
    }),
    { ...env, ADMIN_API_DOMAIN: 'bifrost.example.com', ...bindings },
    ctx,
  );
  await settled();
  const text = await response.text();
  let parsed: Answer;
  try {
    parsed = JSON.parse(text) as Answer;
  } catch {
    // The bare router has no error handler: an uncaught error is plain text
    parsed = { success: false, error: text };
  }
  return { status: response.status, body: parsed };
}

function upload(bucket: string, key: string, overwrite = true, bindings: Partial<Bindings> = {}) {
  const form = new FormData();
  form.append(
    'file',
    new File([new Uint8Array([1, 2, 3])], 'replacement.png', { type: 'image/png' }),
  );
  form.append('key', key);
  if (overwrite) form.append('overwrite', 'true');
  return call('POST', `/storage/${bucket}/upload`, form, bindings);
}

const remove = (bucket: string, key: string) =>
  call('DELETE', `/storage/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`);
const rename = (bucket: string, oldKey: string, newKey: string) =>
  call('POST', `/storage/${bucket}/rename`, { oldKey, newKey });
const move = (bucket: string, key: string, destinationBucket: string, destinationKey?: string) =>
  call('POST', `/storage/${bucket}/move`, {
    key,
    destinationBucket,
    ...(destinationKey === undefined ? {} : { destinationKey }),
  });

/** A route that shows the image as its link-preview image (and serves a PDF). */
async function imageRoute(path: string, domain = DOMAIN, key = IMAGE_KEY, bucket = 'assets') {
  await createRoute(env.ROUTES, domain, {
    path,
    type: 'r2',
    target: 'previews-test/briefing.pdf',
    previewTitle: 'Briefing',
    previewImageBucket: bucket,
    previewImageKey: key,
    previewImageWidth: 1200,
    previewImageHeight: 630,
  });
}

async function storedBytes(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

const auditActions = async () =>
  (
    await env.DB.prepare('SELECT action FROM audit_logs ORDER BY id').all<{ action: string }>()
  ).results.map(row => row.action);

function captureLines(): string[] {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

beforeAll(async () => {
  await createAuditLogsTable();
});

beforeEach(async () => {
  await clearAllRoutes();
  await clearR2();
  for (const { key } of (await env.ASSETS_BUCKET.list()).objects) {
    await env.ASSETS_BUCKET.delete(key);
  }
  await env.DB.prepare('DELETE FROM audit_logs').run();
  await env.ASSETS_BUCKET.put(IMAGE_KEY, IMAGE, { httpMetadata: { contentType: 'image/png' } });
});

afterEach(() => vi.restoreAllMocks());

describe('measurePreviewImage', () => {
  it('an unknown, unconfigured or unbound bucket is unavailable, before any read', async () => {
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    for (const bucket of ['nope', 'constructor', 'files-user1', 'bifrost-backups']) {
      expect({ bucket, answer: await measurePreviewImage(env, bucket, IMAGE_KEY) }).toEqual({
        bucket,
        answer: { error: PREVIEW_IMAGE_UNAVAILABLE },
      });
    }
    // Configured but not bound in this deployment
    expect(
      await measurePreviewImage(
        { ...env, ASSETS_BUCKET: undefined } as Bindings,
        'assets',
        IMAGE_KEY,
      ),
    ).toEqual({ error: PREVIEW_IMAGE_UNAVAILABLE });
    expect(get).not.toHaveBeenCalled();
  });

  it('measures with a single get and no head; a missing object is not found', async () => {
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    const head = vi.spyOn(env.ASSETS_BUCKET, 'head');
    expect(await measurePreviewImage(env, 'assets', IMAGE_KEY)).toEqual({
      previewImageWidth: 1200,
      previewImageHeight: 630,
    });
    expect(await measurePreviewImage(env, 'assets', 'previews/none.png')).toEqual({
      error: PREVIEW_IMAGE_NOT_FOUND,
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(head).not.toHaveBeenCalled();
  });

  it('an object over the limit is refused from its size, its body cancelled unread', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {});
    const arrayBuffer = vi.fn<() => Promise<ArrayBuffer>>();
    // The one `get` answers the size before any of the body is read
    vi.spyOn(env.ASSETS_BUCKET, 'get').mockResolvedValue({
      size: PREVIEW_IMAGE_MAX_BYTES + 1,
      body: { cancel },
      arrayBuffer,
    } as unknown as R2ObjectBody);
    expect(await measurePreviewImage(env, 'assets', 'previews/big.png')).toEqual({
      error: PREVIEW_IMAGE_TOO_LARGE,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('nothing is measured when the write names no image', async () => {
    const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
    expect(await previewImageSizeForWrite(env, {}, true)).toBeUndefined();
    expect(
      await previewImageSizeForWrite(
        env,
        { previewImageBucket: 'assets', previewImageKey: IMAGE_KEY },
        false,
      ),
    ).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('which buckets are checked', () => {
  it('a bucket that can hold a preview image: one with a custom domain', () => {
    expect(mayHoldPreviewImage('assets')).toBe(true);
    expect(mayHoldPreviewImage('files')).toBe(true);
    expect(mayHoldPreviewImage('files-user1')).toBe(false);
    expect(mayHoldPreviewImage('bifrost-backups')).toBe(false);
  });
});

describe('the refusal text', () => {
  it('names the routes sorted, then the domain defaults; one opening per write', () => {
    expect(
      previewImageInUseMessage(
        [
          { domain: 'links.example.com', path: '/b' },
          { domain: 'example.com', path: '/a' },
        ],
        ['user1.example.com'],
        'replace',
      ),
    ).toBe(
      `${PREVIEW_IMAGE_IN_USE_TEXT.replace} Used by example.com/a, links.example.com/b and the default card image of user1.example.com.`,
    );
    expect(previewImageInUseMessage([], ['example.com'], 'delete')).toBe(
      `${PREVIEW_DEFAULT_IMAGE_IN_USE_TEXT.delete} Used by the default card image of example.com.`,
    );
    for (const write of ['replace', 'delete', 'rename', 'move'] as const) {
      expect(PREVIEW_IMAGE_IN_USE_TEXT[write]).toContain(
        { replace: 'replaced', delete: 'deleted', rename: 'renamed', move: 'moved' }[write],
      );
    }
  });
});

describe('replacing a preview image is refused', () => {
  it('an upload with overwrite onto the image is a 409 that names the route; nothing changes', async () => {
    await imageRoute('/briefing');
    const before = await env.ASSETS_BUCKET.head(IMAGE_KEY);
    const { status, body } = await upload('assets', IMAGE_KEY);
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: 'STORE_PREVIEW_IMAGE_IN_USE',
      message: `${PREVIEW_IMAGE_IN_USE_TEXT.replace} Used by links.example.com/briefing.`,
    });
    expect(await storedBytes(env.ASSETS_BUCKET, IMAGE_KEY)).toEqual(IMAGE);
    expect((await env.ASSETS_BUCKET.head(IMAGE_KEY))?.etag).toBe(before?.etag);
    expect(await auditActions()).toEqual([]);
  });

  it('a route that serves the object and names it as its image counts too', async () => {
    await createRoute(env.ROUTES, DOMAIN, {
      path: '/self',
      type: 'r2',
      target: IMAGE_KEY,
      bucket: 'assets',
      previewTitle: 'Self',
      previewImageBucket: 'assets',
      previewImageKey: IMAGE_KEY,
      previewImageWidth: 1200,
      previewImageHeight: 630,
    });
    const { status, body } = await upload('assets', IMAGE_KEY);
    expect(status).toBe(409);
    expect(body.message).toContain('links.example.com/self');
  });

  it('an overwrite of an object no route shows as its image succeeds as before', async () => {
    await createRoute(env.ROUTES, DOMAIN, {
      path: '/serves',
      type: 'r2',
      target: IMAGE_KEY,
      bucket: 'assets',
    });
    const { status } = await upload('assets', IMAGE_KEY);
    expect(status).toBe(201);
    expect(await auditActions()).toEqual(['r2_replace']);
  });

  it("a domain's default card image is refused the same way, naming the domain", async () => {
    const defaults = PREVIEW_DEFAULT_IMAGES as Record<string, PreviewImageRef | null>;
    defaults['example.com'] = { bucket: 'assets', key: IMAGE_KEY, width: 1200, height: 630 };
    try {
      const { status, body } = await upload('assets', IMAGE_KEY);
      expect(status).toBe(409);
      expect(body.message).toBe(
        `${PREVIEW_DEFAULT_IMAGE_IN_USE_TEXT.replace} Used by the default card image of example.com.`,
      );
    } finally {
      defaults['example.com'] = null;
    }
  });

  it('an upload to a new key, or without overwrite, never runs the lookup', async () => {
    await imageRoute('/briefing');
    const list = vi.spyOn(env.ROUTES, 'list');
    expect((await upload('assets', 'previews/new.png')).status).toBe(201);
    const conflict = await upload('assets', IMAGE_KEY, false);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      success: false,
      error: `Object already exists: ${IMAGE_KEY}`,
      code: 'STORE_OBJECT_EXISTS',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('the purge after an overwrite reuses the check scan and purges the routes serving the object', async () => {
    const purged: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/purge_cache')) {
          purged.push(...(JSON.parse(String(init?.body ?? '{}')) as { files: string[] }).files);
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    try {
      const key = 'previews/served.png';
      await env.ASSETS_BUCKET.put(key, IMAGE);
      await createRoute(env.ROUTES, DOMAIN, {
        path: '/served',
        type: 'r2',
        target: key,
        bucket: 'assets',
      });
      // The same key in another bucket serves another object: not purged
      await createRoute(env.ROUTES, DOMAIN, {
        path: '/other-bucket',
        type: 'r2',
        target: key,
        bucket: 'files',
      });
      const list = vi.spyOn(env.ROUTES, 'list');
      const { status } = await upload('assets', key, true, { CLOUDFLARE_API_TOKEN: 'test-token' });
      expect(status).toBe(201);
      expect(list).toHaveBeenCalledTimes(1);
      expect(purged).toContain('https://links.example.com/served');
      expect(purged).not.toContain('https://links.example.com/other-bucket');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an existing object of any size that a route names is refused (replaced outside the API before)', async () => {
    const big = new Uint8Array(PREVIEW_IMAGE_MAX_BYTES + 1);
    await env.ASSETS_BUCKET.put('previews/big.bin', big);
    await imageRoute('/stale', DOMAIN, 'previews/big.bin');
    const { status, body } = await upload('assets', 'previews/big.bin');
    expect(status).toBe(409);
    expect(body.error).toBe('STORE_PREVIEW_IMAGE_IN_USE');
    expect((await storedBytes(env.ASSETS_BUCKET, 'previews/big.bin'))?.length).toBe(
      PREVIEW_IMAGE_MAX_BYTES + 1,
    );
  });

  it('a route lookup that fails writes nothing and logs no key', async () => {
    await imageRoute('/briefing');
    const lines = captureLines();
    vi.spyOn(env.ROUTES, 'list').mockRejectedValueOnce(new Error(`KV down at ${IMAGE_KEY}`));
    const { status, body } = await upload('assets', IMAGE_KEY);
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(await storedBytes(env.ASSETS_BUCKET, IMAGE_KEY)).toEqual(IMAGE);
    expect(await auditActions()).toEqual([]);
    for (const line of lines) expect(line).not.toContain(IMAGE_KEY);
  });

  it('a stored record with an empty, unknown or unconfigured image bucket names no object', async () => {
    await imageRoute('/half');
    const stored = JSON.parse((await env.ROUTES.get(`${DOMAIN}:/half`)) ?? '{}');
    for (const previewImageBucket of ['', 'no-such-bucket', 'files-user1', 'bifrost-backups']) {
      await env.ROUTES.put(`${DOMAIN}:/half`, JSON.stringify({ ...stored, previewImageBucket }));
      const { status } = await upload('assets', IMAGE_KEY);
      expect({ previewImageBucket, status }).toEqual({ previewImageBucket, status: 201 });
    }
  });

  it('logs the refusal with the bucket and the code only: no key, no route path', async () => {
    await imageRoute('/secret-briefing');
    const lines = captureLines();
    const { status } = await upload('assets', IMAGE_KEY);
    expect(status).toBe(409);
    for (const line of lines) {
      expect(line).not.toContain(IMAGE_KEY);
      expect(line).not.toContain('secret-briefing');
    }
    const refusal = lines
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line['error'] === 'STORE_PREVIEW_IMAGE_IN_USE');
    expect(refusal).toEqual({
      level: 'warn',
      message:
        'Upload refused: the object is a link-preview image (of a route or a domain default)',
      error: 'STORE_PREVIEW_IMAGE_IN_USE',
      bucket: 'assets',
    });
  });

  // It seeds 1,100 KV keys on purpose (past one listing page): a loaded runner needs more than 5 s
  it('with more than 1,000 route keys an overwrite is still checked, inside the KV budget', {
    timeout: 30_000,
  }, async () => {
    const bulkKeys = Array.from({ length: 1_100 }, (_, index) => `${DOMAIN}:/bulk-${index}`);
    // Removed here, in parallel: the next beforeEach deletes keys one at a time.
    // Every delete is awaited, and a failure here never hides the test's own.
    const removeBulkKeys = async () => {
      const settled = await Promise.allSettled(bulkKeys.map(key => env.ROUTES.delete(key)));
      return settled.filter(result => result.status === 'rejected').length;
    };
    try {
      await Promise.all(
        bulkKeys.map((key, index) =>
          env.ROUTES.put(
            key,
            JSON.stringify({
              path: `/bulk-${index}`,
              type: 'r2',
              target: `files/bulk-${index}.pdf`,
              bucket: 'files',
            }),
          ),
        ),
      );
      await imageRoute('/briefing');
      const list = vi.spyOn(env.ROUTES, 'list');
      const get = vi.spyOn(env.ROUTES, 'get');
      const { status, body } = await upload('assets', IMAGE_KEY);
      expect(status).toBe(409);
      expect(body.message).toBe(
        `${PREVIEW_IMAGE_IN_USE_TEXT.replace} Used by links.example.com/briefing.`,
      );
      // 1,101 route keys: 2 listing pages and 12 bulk reads, far inside 1,000
      expect(list.mock.calls.length + get.mock.calls.length).toBeLessThan(50);
      expect(await storedBytes(env.ASSETS_BUCKET, IMAGE_KEY)).toEqual(IMAGE);
    } catch (error) {
      await removeBulkKeys();
      throw error;
    }
    const failedDeletes = await removeBulkKeys();
    if (failedDeletes > 0) {
      throw new Error(`${failedDeletes} of ${bulkKeys.length} bulk-key deletes failed`);
    }
  });

  it('a route is named where it is served: by its KV key, not its record path', async () => {
    await env.ROUTES.put(
      `${DOMAIN}:/served-here`,
      JSON.stringify({
        path: '/somewhere-else',
        type: 'r2',
        target: 'a.pdf',
        previewTitle: 'T',
        previewImageBucket: 'assets',
        previewImageKey: IMAGE_KEY,
        previewImageWidth: 1200,
        previewImageHeight: 630,
      }),
    );
    const { body } = await upload('assets', IMAGE_KEY);
    expect(body.message).toContain('links.example.com/served-here');
    expect(body.message).not.toContain('somewhere-else');
  });

  it('in a bucket that cannot hold a preview image no check runs: a failing scan only degrades the purge', async () => {
    await env.FILES_BUCKET.put('docs/a.pdf', 'pdf');
    const domains = (await import('../../src/types')).R2_BUCKET_CUSTOM_DOMAINS;
    const saved = domains['files'];
    delete domains['files'];
    try {
      const lines = captureLines();
      const list = vi.spyOn(env.ROUTES, 'list').mockRejectedValue(new Error('KV down'));
      const { status } = await upload('files', 'docs/a.pdf');
      expect(status).toBe(201);
      // No check scan: the one listing is the purge's own, after the write,
      // which degrades to an incomplete discovery
      expect(list).toHaveBeenCalledTimes(1);
      expect(lines.join('\n')).toContain('route discovery incomplete');
    } finally {
      if (saved) domains['files'] = saved;
    }
  });
});

describe('deleting, renaming or moving a preview image is refused', () => {
  const REFUSED = {
    delete: () => remove('assets', IMAGE_KEY),
    rename: () => rename('assets', IMAGE_KEY, 'previews/renamed.png'),
    move: () => move('assets', IMAGE_KEY, 'files'),
  } as const;

  it.each(Object.keys(REFUSED) as Array<keyof typeof REFUSED>)(
    '%s of a route image is a 409 naming the route; the object stays',
    async write => {
      await imageRoute('/briefing');
      const { status, body } = await REFUSED[write]();
      expect(status).toBe(409);
      expect(body).toEqual({
        success: false,
        error: 'STORE_PREVIEW_IMAGE_IN_USE',
        message: `${PREVIEW_IMAGE_IN_USE_TEXT[write]} Used by links.example.com/briefing.`,
      });
      expect(await storedBytes(env.ASSETS_BUCKET, IMAGE_KEY)).toEqual(IMAGE);
      expect(await env.ASSETS_BUCKET.head('previews/renamed.png')).toBeNull();
      expect(await env.FILES_BUCKET.head(IMAGE_KEY)).toBeNull();
      expect(await auditActions()).toEqual([]);
    },
  );

  it.each(Object.keys(REFUSED) as Array<keyof typeof REFUSED>)(
    '%s of an object no route shows as its image works as before',
    async write => {
      const { status } = await REFUSED[write]();
      expect(status).toBe(200);
    },
  );

  it('the destination side keeps its own 409, checked first: no lookup', async () => {
    await imageRoute('/briefing');
    await env.ASSETS_BUCKET.put('previews/taken.png', IMAGE);
    await env.FILES_BUCKET.put(IMAGE_KEY, IMAGE);
    const list = vi.spyOn(env.ROUTES, 'list');
    const renamed = await rename('assets', IMAGE_KEY, 'previews/taken.png');
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toBe('Destination already exists: previews/taken.png');
    const moved = await move('assets', IMAGE_KEY, 'files');
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe(`Destination already exists: files/${IMAGE_KEY}`);
    expect(list).not.toHaveBeenCalled();
  });

  it('a delete then re-upload can no longer leave a stale size: the delete is refused', async () => {
    await imageRoute('/briefing');
    expect((await remove('assets', IMAGE_KEY)).status).toBe(409);
    expect(await env.ROUTES.get(`${DOMAIN}:/briefing`)).toContain('"previewImageWidth":1200');
  });
});

/** Make the first `head` of `key` answer null, as a check made just before another writer's create. */
function missedHead(bucket: R2Bucket, key: string): void {
  const realHead = bucket.head.bind(bucket);
  let seen = false;
  vi.spyOn(bucket, 'head').mockImplementation((async (name: string) => {
    if (name === key && !seen) {
      seen = true;
      return null;
    }
    return realHead(name);
  }) as typeof bucket.head);
}

describe('create-only writes never replace a concurrent create', () => {
  it('a new-key upload whose key is created after its existence check never replaces it', async () => {
    await env.ASSETS_BUCKET.put('previews/raced.png', IMAGE);
    missedHead(env.ASSETS_BUCKET, 'previews/raced.png');
    const { status, body } = await upload('assets', 'previews/raced.png', false);
    expect(status).toBe(409);
    expect(body.code).toBe('STORE_OBJECT_EXISTS');
    expect(await storedBytes(env.ASSETS_BUCKET, 'previews/raced.png')).toEqual(IMAGE);
    expect(await auditActions()).toEqual([]);
  });

  it('a rename whose destination appears meanwhile keeps the source and the destination', async () => {
    await env.ASSETS_BUCKET.put('previews/source.png', pngBytes(10, 10));
    await env.ASSETS_BUCKET.put('previews/dest.png', IMAGE);
    missedHead(env.ASSETS_BUCKET, 'previews/dest.png');
    const { status, body } = await rename('assets', 'previews/source.png', 'previews/dest.png');
    expect(status).toBe(409);
    expect(body.error).toBe('Destination already exists: previews/dest.png');
    expect(await storedBytes(env.ASSETS_BUCKET, 'previews/dest.png')).toEqual(IMAGE);
    expect(await env.ASSETS_BUCKET.head('previews/source.png')).not.toBeNull();
  });

  it('a move whose destination appears meanwhile keeps the source and the destination', async () => {
    await env.ASSETS_BUCKET.put('previews/source.png', pngBytes(10, 10));
    await env.FILES_BUCKET.put('previews/source.png', IMAGE);
    missedHead(env.FILES_BUCKET, 'previews/source.png');
    const { status, body } = await move('assets', 'previews/source.png', 'files');
    expect(status).toBe(409);
    expect(body.error).toBe('Destination already exists: files/previews/source.png');
    expect(await storedBytes(env.FILES_BUCKET, 'previews/source.png')).toEqual(IMAGE);
    expect(await env.ASSETS_BUCKET.head('previews/source.png')).not.toBeNull();
  });

  it('a new-key upload, a rename and a move to a free key work as before', async () => {
    expect((await upload('assets', 'previews/fresh.png', false)).status).toBe(201);
    expect((await rename('assets', 'previews/fresh.png', 'previews/fresh-2.png')).status).toBe(200);
    expect((await move('assets', 'previews/fresh-2.png', 'files')).status).toBe(200);
    expect(await env.FILES_BUCKET.head('previews/fresh-2.png')).not.toBeNull();
  });
});

describe('GET /api/routes/by-target', () => {
  it('requires both parameters and a storage bucket', async () => {
    expect((await call('GET', '/routes/by-target?bucket=assets')).status).toBe(400);
    expect((await call('GET', `/routes/by-target?target=${IMAGE_KEY}`)).status).toBe(400);
    const unknown = await call('GET', `/routes/by-target?bucket=constructor&target=${IMAGE_KEY}`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('bucket is not a storage bucket');
    expect((await call('GET', `/routes/by-target?bucket=bifrost-backups&target=a`)).status).toBe(
      200,
    );
  });

  it('a stored previewImage field never makes a flag; a route naming the object is flagged', async () => {
    await env.ROUTES.put(
      `${DOMAIN}:/forged`,
      JSON.stringify({
        path: '/forged',
        type: 'r2',
        target: IMAGE_KEY,
        bucket: 'assets',
        previewImage: true,
      }),
    );
    await imageRoute('/briefing');
    const { body } = await call('GET', `/routes/by-target?bucket=assets&target=${IMAGE_KEY}`);
    const routes = (body.data?.['routes'] ?? []) as Array<Record<string, unknown>>;
    const forged = routes.find(route => route['path'] === '/forged');
    expect(forged).toMatchObject({ usage: 'file' });
    expect(forged).not.toHaveProperty('previewImage');
    expect(routes.find(route => route['path'] === '/briefing')).toMatchObject({
      usage: 'preview-image',
      previewImage: true,
    });
    // The forged flag refuses nothing either
    expect((await upload('assets', 'previews/other.png')).status).toBe(201);
  });
});
