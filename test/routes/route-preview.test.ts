import { env } from 'cloudflare:test';
import {
  PREVIEW_IMAGE_PAIR_ERROR,
  PREVIEW_R2_ONLY_ERROR,
  PREVIEW_TITLE_REQUIRED_ERROR,
  PREVIEW_VIDEO_PAIR_ERROR,
  PREVIEW_WILDCARD_ERROR,
  ROUTE_WRITE_MAX_BYTES,
} from '@bifrost/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../../src/routes/admin';
import {
  PREVIEW_IMAGE_KEY_INVALID,
  PREVIEW_IMAGE_NOT_FOUND,
  PREVIEW_IMAGE_NOT_IMAGE,
  PREVIEW_IMAGE_TOO_LARGE,
  PREVIEW_IMAGE_UNAVAILABLE,
} from '../../src/routes/route-preview-image';
import type { AppEnv } from '../../src/types';
import { clearAllRoutes, clearR2, createSettlingExecutionContext } from '../helpers';
import { jpegBytes, pngBytes } from '../image-bytes';
import { usePreviewBuckets } from '../link-preview-config';

/**
 * Link-preview fields through the Admin API (v1.48.0): create, read, update,
 * clear, seed and migrate, and the write-time rules. The image's pixel size
 * is read from the image itself through the R2 binding. Stored preview data
 * never refuses a write that leaves the preview alone.
 */

usePreviewBuckets();

const API_KEY = 'test-api-key-12345'; // gitleaks:allow
const DOMAIN = 'links.example.com';
const IMAGE_KEY = 'previews/briefing-1200x630.png';

interface Answer {
  success: boolean;
  error?: string;
  data?: Record<string, unknown> & { routes?: Array<Record<string, unknown>> };
  details?: unknown;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Answer }> {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await new Hono<AppEnv>().route('/api', adminRoutes).fetch(
    new Request(`http://bifrost.example.com/api${path}`, {
      method,
      headers: {
        'X-Admin-Key': API_KEY,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, ADMIN_API_DOMAIN: 'bifrost.example.com' },
    ctx,
  );
  await settled();
  return { status: response.status, body: (await response.json()) as Answer };
}

const create = (route: Record<string, unknown>, domain = DOMAIN) =>
  call('POST', `/routes?domain=${domain}`, route);
const update = (path: string, patch: Record<string, unknown>) =>
  call('PUT', `/routes?domain=${DOMAIN}&path=${encodeURIComponent(path)}`, patch);
const migrate = (oldPath: string, newPath: string, body?: Record<string, unknown>) =>
  call(
    'POST',
    `/routes/migrate?domain=${DOMAIN}&oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(newPath)}`,
    body,
  );
const seed = (routes: unknown[]) => call('POST', `/routes/seed?domain=${DOMAIN}`, { routes });
const stored = async (path: string, domain = DOMAIN) => {
  const text = await env.ROUTES.get(`${domain}:${path}`);
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
};

const fileRoute = (overrides: Record<string, unknown> = {}) => ({
  path: '/briefing',
  type: 'r2',
  target: 'previews-test/briefing.pdf',
  ...overrides,
});

const withImage = {
  previewTitle: '  Quarterly briefing\n2026  ',
  previewDescription: 'Facts\u0007 and figures',
  previewImageBucket: 'assets',
  previewImageKey: IMAGE_KEY,
  // Client-supplied sizes are never stored: the image decides
  previewImageWidth: 9999,
  previewImageHeight: 9999,
};

describe('link-preview fields through the Admin API (v1.48.0)', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    await env.ASSETS_BUCKET.put(IMAGE_KEY, pngBytes(1200, 630, 100), {
      httpMetadata: { contentType: 'image/png' },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('create stores sanitised text and the size read from the image; reads return them', async () => {
    const created = await create(fileRoute(withImage));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      previewTitle: 'Quarterly briefing 2026',
      previewDescription: 'Facts and figures',
      previewImageBucket: 'assets',
      previewImageKey: IMAGE_KEY,
      previewImageWidth: 1200,
      previewImageHeight: 630,
    });
    expect(await stored('/briefing')).toMatchObject({ previewImageWidth: 1200 });

    const single = await call('GET', `/routes?domain=${DOMAIN}&path=/briefing`);
    expect(JSON.stringify(single.body)).toContain('"previewImageHeight":630');
    const list = await call('GET', `/routes?domain=${DOMAIN}`);
    expect(JSON.stringify(list.body)).toContain('"previewTitle":"Quarterly briefing 2026"');
  });

  it('reads a JPEG too', async () => {
    await env.ASSETS_BUCKET.put('previews/card.jpg', jpegBytes(1080, 1080));
    const created = await create(
      fileRoute({
        previewTitle: 'T',
        previewImageBucket: 'assets',
        previewImageKey: 'previews/card.jpg',
      }),
    );
    expect(created.body.data).toMatchObject({ previewImageWidth: 1080, previewImageHeight: 1080 });
  });

  it('empty text drops the field on create; a title alone is a card', async () => {
    const created = await create(
      fileRoute({
        previewTitle: 'T',
        previewDescription: '   ',
        previewImageBucket: '',
        previewImageKey: '',
      }),
    );
    expect(created.status).toBe(201);
    const record = await stored('/briefing');
    expect(record?.['previewTitle']).toBe('T');
    for (const field of [
      'previewDescription',
      'previewImageBucket',
      'previewImageKey',
      'previewImageWidth',
    ]) {
      expect(record).not.toHaveProperty(field);
    }
  });

  it.each([
    [
      'a redirect route',
      { type: 'redirect', target: 'https://example.com', previewTitle: 'T' },
      PREVIEW_R2_ONLY_ERROR,
    ],
    ['a wildcard route', { path: '/docs/*', previewTitle: 'T' }, PREVIEW_WILDCARD_ERROR],
    ['no title', { previewDescription: 'D' }, PREVIEW_TITLE_REQUIRED_ERROR],
    [
      'a whitespace title',
      { previewTitle: '  ', previewDescription: 'D' },
      PREVIEW_TITLE_REQUIRED_ERROR,
    ],
    ['half an image', { previewTitle: 'T', previewImageKey: IMAGE_KEY }, PREVIEW_IMAGE_PAIR_ERROR],
    ['half a video size', { previewTitle: 'T', previewVideoWidth: 1920 }, PREVIEW_VIDEO_PAIR_ERROR],
    [
      'a missing image',
      { previewTitle: 'T', previewImageBucket: 'assets', previewImageKey: 'none.png' },
      PREVIEW_IMAGE_NOT_FOUND,
    ],
    [
      'an invalid image key',
      { previewTitle: 'T', previewImageBucket: 'assets', previewImageKey: '../x.png' },
      PREVIEW_IMAGE_KEY_INVALID,
    ],
  ])('create refuses %s, writing nothing', async (_label, fields, error) => {
    const route = fileRoute(fields);
    const answer = await create(route);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe(error);
    expect(await stored(String(route.path))).toBeNull();
  });

  it('a percent-encoded wildcard path is judged as the wildcard route it is stored as', async () => {
    // Create: `/docs/%2A` is stored at `/docs/*`
    const created = await create(fileRoute({ path: '/docs/%2A', previewTitle: 'T' }));
    expect(created.status).toBe(400);
    expect(created.body.error).toBe(PREVIEW_WILDCARD_ERROR);
    expect(await stored('/docs/*')).toBeNull();

    // Seed: the same, listed against the path as sent
    const seeded = await seed([fileRoute({ path: '/r4/%2A', previewTitle: 'T' })]);
    expect(seeded.status).toBe(400);
    expect(seeded.body.details).toEqual([
      { path: '/r4/%2A', issues: [{ code: 'custom', message: PREVIEW_WILDCARD_ERROR, path: [] }] },
    ]);
    expect(await stored('/r4/*')).toBeNull();

    // Update: a wildcard route addressed as `/docs/%2A` takes no preview
    expect((await create(fileRoute({ path: '/docs/*', target: 'docs/' }))).status).toBe(201);
    const updated = await update('/docs/%2A', { previewTitle: 'T' });
    expect(updated.status).toBe(400);
    expect(updated.body.error).toBe(PREVIEW_WILDCARD_ERROR);
    expect(await stored('/docs/*')).not.toHaveProperty('previewTitle');
  });

  it('create refuses an image that is too large or not a JPEG or PNG, naming no key', async () => {
    await env.ASSETS_BUCKET.put('previews/big.png', pngBytes(10, 10, 600_000 - 33 + 1));
    await env.ASSETS_BUCKET.put('previews/fake.png', 'GIF89a not a png');
    for (const [key, error] of [
      ['previews/big.png', PREVIEW_IMAGE_TOO_LARGE],
      ['previews/fake.png', PREVIEW_IMAGE_NOT_IMAGE],
    ]) {
      const answer = await create(
        fileRoute({ previewTitle: 'T', previewImageBucket: 'assets', previewImageKey: key }),
      );
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe(error);
      expect(answer.body.error).not.toContain(key);
    }
  });

  it('the limit is 600,000 bytes: exactly that is accepted', async () => {
    await env.ASSETS_BUCKET.put('previews/edge.png', pngBytes(1200, 630, 600_000 - 33));
    const accepted = await create(
      fileRoute({
        previewTitle: 'T',
        previewImageBucket: 'assets',
        previewImageKey: 'previews/edge.png',
      }),
    );
    expect(accepted.status).toBe(201);
    expect(PREVIEW_IMAGE_TOO_LARGE).toBe(
      'The preview image must be at most 600 KB (600,000 bytes)',
    );
  });

  it('create refuses an image bucket with no custom domain at the schema, reading nothing', async () => {
    const get = vi.spyOn(env.FILES_BUCKET, 'get');
    const answer = await create(
      fileRoute({ previewTitle: 'T', previewImageBucket: 'files-user1', previewImageKey: 'a.png' }),
    );
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('Validation failed');
    expect(JSON.stringify(answer.body.details)).toContain('custom domain');
    expect(get).not.toHaveBeenCalled();
  });

  it('a configured bucket the deployment does not bind is refused as unavailable', async () => {
    const domains = (await import('../../src/types')).R2_BUCKET_CUSTOM_DOMAINS;
    domains['files-user2'] = ['user2-files.example.com'];
    try {
      const answer = await create(
        fileRoute({
          previewTitle: 'T',
          previewImageBucket: 'files-user2',
          previewImageKey: 'a.png',
        }),
      );
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe(PREVIEW_IMAGE_UNAVAILABLE);
    } finally {
      delete domains['files-user2'];
    }
  });

  it('create refuses an over-long title or description', async () => {
    for (const fields of [
      { previewTitle: 'x'.repeat(121) },
      { previewTitle: 'T', previewDescription: 'x'.repeat(241) },
    ]) {
      const answer = await create(fileRoute(fields));
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('Validation failed');
    }
  });

  describe('update', () => {
    beforeEach(async () => {
      const created = await create(
        fileRoute({ ...withImage, previewVideoWidth: 1920, previewVideoHeight: 1080 }),
      );
      if (created.status !== 201) throw new Error(`setup create answered ${created.status}`);
    });

    it('a patch that omits the preview fields leaves them unchanged', async () => {
      const answer = await update('/briefing', { cacheControl: 'max-age=60' });
      expect(answer.status).toBe(200);
      expect(await stored('/briefing')).toMatchObject({
        previewTitle: 'Quarterly briefing 2026',
        previewImageWidth: 1200,
        previewVideoWidth: 1920,
        cacheControl: 'max-age=60',
      });
    });

    it('a toggle leaves the preview as it is', async () => {
      expect((await update('/briefing', { enabled: false })).status).toBe(200);
      expect(await stored('/briefing')).toMatchObject({
        enabled: false,
        previewImageWidth: 1200,
      });
    });

    it('an empty title clears every preview field', async () => {
      const answer = await update('/briefing', { previewTitle: '' });
      expect(answer.status).toBe(200);
      const record = await stored('/briefing');
      for (const field of Object.keys(record ?? {})) {
        expect(field.startsWith('preview')).toBe(false);
      }
    });

    it('an empty description clears it; null clears the video size', async () => {
      await update('/briefing', {
        previewDescription: '',
        previewVideoWidth: null,
        previewVideoHeight: null,
      });
      const record = await stored('/briefing');
      expect(record).not.toHaveProperty('previewDescription');
      expect(record).not.toHaveProperty('previewVideoWidth');
      expect(record).toMatchObject({
        previewTitle: 'Quarterly briefing 2026',
        previewImageWidth: 1200,
      });
    });

    it('a new image is measured again; clearing the image drops its size', async () => {
      await env.ASSETS_BUCKET.put('previews/square.png', pngBytes(800, 800));
      await update('/briefing', { previewImageKey: 'previews/square.png', previewImageWidth: 1 });
      expect(await stored('/briefing')).toMatchObject({
        previewImageWidth: 800,
        previewImageHeight: 800,
      });
      await update('/briefing', { previewImageBucket: '', previewImageKey: '' });
      const record = await stored('/briefing');
      expect(record).not.toHaveProperty('previewImageKey');
      expect(record).not.toHaveProperty('previewImageWidth');
    });

    it('a new image that is missing is refused and nothing changes', async () => {
      const answer = await update('/briefing', { previewImageKey: 'previews/gone.png' });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe(PREVIEW_IMAGE_NOT_FOUND);
      expect(await stored('/briefing')).toMatchObject({ previewImageKey: IMAGE_KEY });
    });

    it('a type change away from r2 is refused while the preview stays, allowed with the title cleared', async () => {
      const kept = await update('/briefing', { type: 'redirect', target: 'https://example.com' });
      expect(kept.status).toBe(400);
      expect(kept.body.error).toBe(PREVIEW_R2_ONLY_ERROR);
      const cleared = await update('/briefing', {
        type: 'redirect',
        target: 'https://example.com',
        previewTitle: '',
      });
      expect(cleared.status).toBe(200);
      expect(await stored('/briefing')).not.toHaveProperty('previewTitle');
    });

    it('migrate with changes measures a new image and moves the preview', async () => {
      await env.ASSETS_BUCKET.put('previews/wide.png', pngBytes(1600, 900));
      const answer = await migrate('/briefing', '/briefing-2026', {
        previewImageKey: 'previews/wide.png',
      });
      expect(answer.status).toBe(200);
      expect(await stored('/briefing-2026')).toMatchObject({
        previewTitle: 'Quarterly briefing 2026',
        previewImageWidth: 1600,
        previewImageHeight: 900,
      });
      const refused = await migrate('/briefing-2026', '/briefing-x', {
        previewImageKey: 'previews/none.png',
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(PREVIEW_IMAGE_NOT_FOUND);
      expect(await stored('/briefing-x')).toBeNull();
      expect(await stored('/briefing-2026')).not.toBeNull();
    });

    it('a plain move keeps the preview; a move to a wildcard path is refused while it has one', async () => {
      expect((await migrate('/briefing', '/briefing-moved')).status).toBe(200);
      expect(await stored('/briefing-moved')).toMatchObject({ previewImageWidth: 1200 });
      const wildcard = await migrate('/briefing-moved', '/docs/*');
      expect(wildcard.status).toBe(400);
      expect(wildcard.body.error).toBe(PREVIEW_WILDCARD_ERROR);
      expect(await stored('/briefing-moved')).not.toBeNull();
      // With the title cleared in the same move, it goes through
      expect((await migrate('/briefing-moved', '/docs/*', { previewTitle: '' })).status).toBe(200);
      expect(await stored('/docs/*')).not.toHaveProperty('previewTitle');
    });
  });

  describe('stored preview data never refuses a write that leaves it alone', () => {
    beforeEach(async () => {
      // A record whose stored preview no write would accept today: an image
      // bucket with no custom domain and a title with surrounding spaces
      await env.ROUTES.put(
        `${DOMAIN}:/legacy`,
        JSON.stringify({
          path: '/legacy',
          type: 'r2',
          target: 'a.pdf',
          previewTitle: ' padded ',
          previewImageBucket: 'files-user1',
          previewImageKey: 'gone.png',
          createdAt: 1,
          updatedAt: 1,
        }),
      );
    });

    it('an edit, a toggle, a plain move and a transfer go through', async () => {
      expect((await update('/legacy', { cacheControl: 'max-age=1' })).status).toBe(200);
      expect((await update('/legacy', { enabled: false })).status).toBe(200);
      expect((await migrate('/legacy', '/legacy-2')).status).toBe(200);
      const transfer = await call('POST', '/routes/transfer', {
        path: '/legacy-2',
        fromDomain: DOMAIN,
        toDomain: 'example.com',
      });
      expect(transfer.status).toBe(200);
      expect(await stored('/legacy-2', 'example.com')).toMatchObject({
        previewImageBucket: 'files-user1',
      });
    });

    it('an edit that touches the preview has the rules checked on the result; saving fixes or clears it', async () => {
      const touched = await update('/legacy', { previewDescription: 'D' });
      expect(touched.status).toBe(400);
      expect(touched.body.error).toMatch(/custom domain/);
      expect((await update('/legacy', { previewTitle: '' })).status).toBe(200);
      const record = await stored('/legacy');
      expect(Object.keys(record ?? {}).some(field => field.startsWith('preview'))).toBe(false);
    });
  });

  describe('seed', () => {
    it('measures each created entry image and refuses a bad one before writing anything', async () => {
      const good = await seed([fileRoute({ path: '/seeded', ...withImage })]);
      expect(good.status).toBe(200);
      expect(await stored('/seeded')).toMatchObject({
        previewImageWidth: 1200,
        previewTitle: 'Quarterly briefing 2026',
      });
      const bad = await seed([
        fileRoute({ path: '/seed-a', previewTitle: 'A' }),
        fileRoute({
          path: '/seed-b',
          previewTitle: 'B',
          previewImageBucket: 'assets',
          previewImageKey: 'none.png',
        }),
      ]);
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('Some routes failed validation');
      expect(bad.body.details).toEqual([
        {
          path: '/seed-b',
          issues: [{ code: 'custom', message: PREVIEW_IMAGE_NOT_FOUND, path: [] }],
        },
      ]);
      expect(await stored('/seed-a')).toBeNull();
    });

    it('lists every refused rule or image against each route naming it, nothing written', async () => {
      const rules = await seed([
        fileRoute({ path: '/r1', previewDescription: 'no title' }),
        fileRoute({ path: '/r2', previewTitle: 'T' }),
        fileRoute({ path: '/r3/*', previewTitle: 'T' }),
      ]);
      expect(rules.status).toBe(400);
      expect(rules.body.details).toEqual([
        {
          path: '/r1',
          issues: [{ code: 'custom', message: PREVIEW_TITLE_REQUIRED_ERROR, path: [] }],
        },
        { path: '/r3/*', issues: [{ code: 'custom', message: PREVIEW_WILDCARD_ERROR, path: [] }] },
      ]);
      expect(await stored('/r2')).toBeNull();

      const images = await seed([
        fileRoute({
          path: '/i1',
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: 'none.png',
        }),
        fileRoute({
          path: '/i2',
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: 'none.png',
        }),
        fileRoute({
          path: '/i3',
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: IMAGE_KEY,
        }),
      ]);
      expect(images.status).toBe(400);
      expect((images.body.details as Array<{ path: string }>).map(entry => entry.path)).toEqual([
        '/i1',
        '/i2',
      ]);
      expect(await stored('/i3')).toBeNull();
    });

    it('never refuses for an entry it skips, and measures a shared image once', async () => {
      await env.ROUTES.put(
        `${DOMAIN}:/existing`,
        JSON.stringify({
          path: '/existing',
          type: 'r2',
          target: 'a.pdf',
          createdAt: 1,
          updatedAt: 1,
        }),
      );
      const get = vi.spyOn(env.ASSETS_BUCKET, 'get');
      const answer = await seed([
        // Skipped (exists): its missing image is never read
        fileRoute({
          path: '/existing',
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: 'none.png',
        }),
        fileRoute({
          path: '/one',
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: IMAGE_KEY,
        }),
        fileRoute({
          path: '/two',
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: IMAGE_KEY,
        }),
        // A losing duplicate of /one: skipped too
        fileRoute({ path: '/One', previewDescription: 'no title' }),
      ]);
      expect(answer.status).toBe(200);
      expect(answer.body.data).toMatchObject({ created: 2, skipped: 2 });
      expect(get).toHaveBeenCalledTimes(1);
      expect(await stored('/two')).toMatchObject({ previewImageWidth: 1200 });
    });
  });

  it('by-target lists routes that show the object as their preview image, with usage', async () => {
    await create(fileRoute({ path: '/serves', target: IMAGE_KEY, bucket: 'assets' }));
    await create(fileRoute(withImage));
    const answer = await call(
      'GET',
      `/routes/by-target?bucket=assets&target=${encodeURIComponent(IMAGE_KEY)}`,
    );
    expect(answer.status).toBe(200);
    const routes = answer.body.data?.routes ?? [];
    expect(routes.map(route => [route['path'], route['usage'], route['previewImage']])).toEqual(
      expect.arrayContaining([
        ['/serves', 'file', undefined],
        ['/briefing', 'preview-image', true],
      ]),
    );
    expect(routes).toHaveLength(2);
  });

  it('a realistic preview create body stays far below the 64 KiB route ceiling', () => {
    const body = JSON.stringify({
      ...fileRoute({ target: `brochures/${'x'.repeat(200)}.pdf` }),
      previewTitle: 'x'.repeat(120),
      previewDescription: 'é'.repeat(240),
      previewImageBucket: 'assets',
      previewImageKey: `previews/${'y'.repeat(200)}.jpg`,
      previewVideoWidth: 1920,
      previewVideoHeight: 1080,
    });
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeLessThan(8 * 1024);
    expect(bytes).toBeLessThan(ROUTE_WRITE_MAX_BYTES);
  });
});
