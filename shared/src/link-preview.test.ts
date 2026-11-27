import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bucketCustomDomainUrl,
  dropOrphanPreviewImageSize,
  hasPreviewFields,
  isCardEligibleFile,
  isPreviewImageBucket,
  isServableImageRef,
  isWildcardRoutePath,
  PREVIEW_DEFAULT_IMAGES,
  PREVIEW_FIELDS,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_KB,
  PREVIEW_IMAGE_PAIR_ERROR,
  PREVIEW_R2_ONLY_ERROR,
  PREVIEW_SITE_NAMES,
  PREVIEW_TITLE_REQUIRED_ERROR,
  PREVIEW_VIDEO_PAIR_ERROR,
  PREVIEW_WILDCARD_ERROR,
  previewCard,
  previewImageBucketError,
  previewImageBuckets,
  previewRuleError,
  sanitizePreviewDescription,
  sanitizePreviewTitle,
  servablePreview,
} from './link-preview.js';
import { isServableR2Key } from './r2-key.js';
import {
  CreateRouteInputSchema,
  CreateRouteToolInputSchema,
  RouteSchema,
  UpdateRouteInputSchema,
  UpdateRouteToolInputSchema,
} from './schemas.js';
import { CLOUDFLARE_ZONE_IDS, R2_BUCKET_CUSTOM_DOMAINS, SUPPORTED_DOMAINS } from './types.js';

/**
 * Link previews for file routes (v1.48.0): the shared rules, the card
 * decision and the operator maps. The template ships the custom-domain map,
 * the zone map, the site names and the default images empty; these tests set
 * the two maps for themselves and restore them.
 */

const DOMAIN = 'links.example.com';

/** A key check that accepts every key. */
const anyKey = () => true;

function configure(): void {
  R2_BUCKET_CUSTOM_DOMAINS['assets'] = ['assets.example.com', 'assets.example.net'];
  R2_BUCKET_CUSTOM_DOMAINS['files'] = ['files.example.com'];
  CLOUDFLARE_ZONE_IDS['example.com'] = 'zone-one';
  CLOUDFLARE_ZONE_IDS['example.net'] = 'zone-two';
}

function restore(): void {
  for (const key of Object.keys(R2_BUCKET_CUSTOM_DOMAINS)) delete R2_BUCKET_CUSTOM_DOMAINS[key];
  for (const key of Object.keys(CLOUDFLARE_ZONE_IDS)) delete CLOUDFLARE_ZONE_IDS[key];
}

describe('the template configuration', () => {
  it('ships no custom domain, so no bucket may hold a preview image', () => {
    expect(R2_BUCKET_CUSTOM_DOMAINS).toEqual({});
    expect(previewImageBuckets()).toEqual([]);
    expect(isPreviewImageBucket('files')).toBe(false);
    expect(previewImageBucketError()).toMatch(/none is configured/);
  });

  it('classifies every supported domain in the site names and the default images, all empty', () => {
    // A new supported domain fails here until its site name and default image
    // are decided (AGENTS.md, "Adding a New Supported Domain")
    expect(Object.keys(PREVIEW_SITE_NAMES).toSorted()).toEqual([...SUPPORTED_DOMAINS].toSorted());
    expect(Object.keys(PREVIEW_DEFAULT_IMAGES).toSorted()).toEqual(
      [...SUPPORTED_DOMAINS].toSorted(),
    );
    expect(Object.values(PREVIEW_SITE_NAMES).every(name => name === null)).toBe(true);
    expect(Object.values(PREVIEW_DEFAULT_IMAGES).every(image => image === null)).toBe(true);
  });

  it('every default image an operator sets is one a route could serve', () => {
    // Holds for the shipped (empty) map; an operator's entry must pass too
    const unservable = Object.entries(PREVIEW_DEFAULT_IMAGES)
      .filter(([, image]) => image !== null && !isServableImageRef(image))
      .map(([domain]) => domain);
    expect(unservable).toEqual([]);
  });
});

describe('preview text sanitising', () => {
  it('trims, drops control characters and keeps a description multi-line', () => {
    expect(sanitizePreviewDescription('  a\r\nb\u0000c\u007f\td  ')).toBe('a\nbc\td');
  });

  it('puts a title on one line', () => {
    expect(sanitizePreviewTitle(' a\nb\tc ')).toBe('a b c');
  });

  it('empty, whitespace-only and nullish text is null', () => {
    for (const raw of ['', '   ', '\n\t', null, undefined, '\u0001']) {
      expect(sanitizePreviewTitle(raw)).toBeNull();
    }
  });
});

describe('preview image size limit', () => {
  it('is 600,000 bytes, stated as 600 KB', () => {
    expect(PREVIEW_IMAGE_MAX_BYTES).toBe(600_000);
    expect(PREVIEW_IMAGE_MAX_KB).toBe(600);
  });
});

describe('with buckets configured', () => {
  beforeEach(configure);
  afterEach(restore);

  describe('preview image buckets', () => {
    it('are the file buckets with a custom domain, read when asked', () => {
      expect(previewImageBuckets()).toEqual(['files', 'assets']);
      expect(isPreviewImageBucket('assets')).toBe(true);
      expect(isPreviewImageBucket('files-user1')).toBe(false);
      expect(isPreviewImageBucket('nope')).toBe(false);
      expect(isPreviewImageBucket('constructor')).toBe(false);
      R2_BUCKET_CUSTOM_DOMAINS['assets'] = [];
      expect(isPreviewImageBucket('assets')).toBe(false);
      expect(previewImageBucketError()).toBe(
        'A preview image must be in a bucket that has a custom domain (one of: files)',
      );
    });

    it('never include a bucket that is not a file bucket', () => {
      R2_BUCKET_CUSTOM_DOMAINS['bifrost-backups'] = ['backups.example.com'];
      expect(isPreviewImageBucket('bifrost-backups')).toBe(false);
    });
  });

  describe('previewRuleError', () => {
    const r2 = { type: 'r2', path: '/report', bucket: 'files' };

    it('a route without preview fields passes, whatever its type', () => {
      expect(previewRuleError({ type: 'redirect' })).toBeNull();
      expect(
        previewRuleError({ type: 'redirect', previewTitle: '', previewVideoWidth: null }),
      ).toBeNull();
      expect(previewRuleError({ type: 'r2', path: '/docs/*' })).toBeNull();
      expect(hasPreviewFields({})).toBe(false);
    });

    it('every field counts as a preview field', () => {
      for (const field of PREVIEW_FIELDS) {
        expect(
          hasPreviewFields({
            [field]: field.includes('Width') || field.includes('Height') ? 1 : 'x',
          }),
        ).toBe(true);
      }
    });

    it.each([
      ['a proxy route', { type: 'proxy', previewTitle: 'T' }, PREVIEW_R2_ONLY_ERROR],
      ['a wildcard route', { ...r2, path: '/docs/*', previewTitle: 'T' }, PREVIEW_WILDCARD_ERROR],
      ['a root wildcard', { ...r2, path: '/*', previewTitle: 'T' }, PREVIEW_WILDCARD_ERROR],
      ['no title', { ...r2, previewImageWidth: 5 }, PREVIEW_TITLE_REQUIRED_ERROR],
      [
        'a key without a bucket',
        { ...r2, previewTitle: 'T', previewImageKey: 'a.png' },
        PREVIEW_IMAGE_PAIR_ERROR,
      ],
      [
        'a bucket without a key',
        { ...r2, previewTitle: 'T', previewImageBucket: 'assets' },
        PREVIEW_IMAGE_PAIR_ERROR,
      ],
      [
        'a bucket with no custom domain',
        { ...r2, previewTitle: 'T', previewImageBucket: 'files-user1', previewImageKey: 'a.png' },
        'A preview image must be in a bucket that has a custom domain (one of: files, assets)',
      ],
      [
        'half a video size',
        { ...r2, previewTitle: 'T', previewVideoHeight: 720 },
        PREVIEW_VIDEO_PAIR_ERROR,
      ],
    ])('refuses %s', (_label, route, error) => {
      expect(previewRuleError(route)).toBe(error);
    });

    it('accepts a complete preview', () => {
      expect(
        previewRuleError({
          type: 'r2',
          path: '/report',
          previewTitle: 'T',
          previewDescription: 'D',
          previewImageBucket: 'assets',
          previewImageKey: 'a.png',
          previewVideoWidth: 1,
          previewVideoHeight: 1,
        }),
      ).toBeNull();
    });

    it('a wildcard is any path holding *', () => {
      expect(isWildcardRoutePath('/docs/*')).toBe(true);
      expect(isWildcardRoutePath('/*')).toBe(true);
      expect(isWildcardRoutePath('/docs')).toBe(false);
    });
  });

  describe('servablePreview', () => {
    const stored = {
      previewTitle: 'Title',
      previewDescription: 'Line one\nline two',
      previewImageBucket: 'assets',
      previewImageKey: 'a.png',
      previewImageWidth: 1200,
      previewImageHeight: 630,
      previewVideoWidth: 1920,
      previewVideoHeight: 1080,
    };

    it('returns the validated preview, nulls read as absent', () => {
      expect(servablePreview(stored, anyKey)).toEqual({
        title: 'Title',
        description: 'Line one\nline two',
        image: { bucket: 'assets', key: 'a.png', width: 1200, height: 630 },
        video: { width: 1920, height: 1080 },
      });
      expect(servablePreview({ previewTitle: 'T', previewVideoWidth: null }, anyKey)).toEqual({
        title: 'T',
      });
    });

    it.each([
      ['no title', { ...stored, previewTitle: undefined }],
      ['an empty title', { ...stored, previewTitle: '' }],
      ['a title over the cap', { ...stored, previewTitle: 'x'.repeat(121) }],
      ['a title that is not sanitised', { ...stored, previewTitle: ' T' }],
      ['a description with a control character', { ...stored, previewDescription: 'a\u0007b' }],
      ['a numeric description', { ...stored, previewDescription: 7 }],
      ['half an image pair', { ...stored, previewImageKey: undefined }],
      ['a bucket no longer configured', { ...stored, previewImageBucket: 'files-user1' }],
      ['an over-long key', { ...stored, previewImageKey: 'k'.repeat(1025) }],
      ['an image without its measured size', { ...stored, previewImageHeight: undefined }],
      ['a key with a lone surrogate', { ...stored, previewImageKey: 'a\uD800.png' }],
      [
        'a measured width with no image',
        {
          ...stored,
          previewImageBucket: undefined,
          previewImageKey: undefined,
          previewImageHeight: undefined,
        },
      ],
      ['half a video size', { ...stored, previewVideoHeight: undefined }],
      ['a video size over the cap', { ...stored, previewVideoWidth: 7681 }],
    ])('is null for %s', (_label, record) => {
      expect(servablePreview(record, anyKey)).toBeNull();
    });

    it('asks the writer key check about the image key', () => {
      const isValidKey = vi.fn<(key: string) => boolean>(key => key.trim() !== '');
      expect(servablePreview({ ...stored, previewImageKey: '   ' }, isValidKey)).toBeNull();
      expect(isValidKey).toHaveBeenCalledWith('   ');
      expect(servablePreview({ ...stored, previewImageKey: '../a.png' }, isServableR2Key)).toBe(
        null,
      );
    });

    it('a bucket removed from the configuration stops serving the image, never the route', () => {
      delete R2_BUCKET_CUSTOM_DOMAINS['assets'];
      expect(servablePreview(stored, anyKey)).toBeNull();
      expect(
        servablePreview(
          { previewTitle: 'Title', previewVideoWidth: 640, previewVideoHeight: 360 },
          anyKey,
        ),
      ).toEqual({ title: 'Title', video: { width: 640, height: 360 } });
    });
  });

  describe('bucketCustomDomainUrl', () => {
    it("picks the custom domain in the request host's zone, else the first", () => {
      expect(bucketCustomDomainUrl('assets', 'a b/c.png', 'links.example.net')).toBe(
        'https://assets.example.net/a%20b/c.png',
      );
      expect(bucketCustomDomainUrl('assets', 'c.png', 'links.example.com')).toBe(
        'https://assets.example.com/c.png',
      );
      // A host in no configured zone: the first domain
      expect(bucketCustomDomainUrl('assets', 'c.png', 'unknown.example.org')).toBe(
        'https://assets.example.com/c.png',
      );
      expect(bucketCustomDomainUrl('files-user1', 'c.png', DOMAIN)).toBeNull();
      // Inherited object keys are no bucket: no throw, no address built from `undefined`
      for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        expect(bucketCustomDomainUrl(name, 'c.png', DOMAIN)).toBeNull();
      }
    });
  });

  describe('previewCard', () => {
    const fallback = { bucket: 'assets', key: 'previews/default.png', width: 1200, height: 630 };
    const defaults = { [DOMAIN]: fallback, 'example.com': null };

    it('carries the title and the description; the template names no site', () => {
      expect(previewCard({ title: 'T', description: 'D' }, DOMAIN, PREVIEW_DEFAULT_IMAGES)).toEqual(
        { title: 'T', description: 'D' },
      );
      for (const host of ['example.com', 'unknown.example.org', 'constructor']) {
        expect(previewCard({ title: 'T' }, host, {})).toEqual({ title: 'T' });
      }
    });

    it("uses the route's own image first, with whatever size it has", () => {
      const own = { bucket: 'files', key: 'cards/a b.jpg', width: 800, height: 600 };
      expect(previewCard({ title: 'T', image: own }, DOMAIN, defaults)).toEqual({
        title: 'T',
        image: {
          url: 'https://files.example.com/cards/a%20b.jpg',
          width: 800,
          height: 600,
          alt: 'T',
        },
        imageSource: 'route',
      });
      // A draft image from the live form has no size yet: none is claimed
      expect(
        previewCard({ title: 'T', image: { bucket: 'assets', key: 'x.png' } }, DOMAIN, {}).image,
      ).toEqual({ url: 'https://assets.example.com/x.png', alt: 'T' });
    });

    it("else the host's default; else no image", () => {
      expect(previewCard({ title: 'T' }, DOMAIN, defaults)).toMatchObject({
        image: {
          url: 'https://assets.example.com/previews/default.png',
          width: 1200,
          height: 630,
        },
        imageSource: 'default',
      });
      expect(previewCard({ title: 'T' }, 'example.com', defaults).image).toBeUndefined();
      expect(previewCard({ title: 'T' }, 'user1.example.com', defaults).image).toBeUndefined();
      expect(previewCard({ title: 'T' }, 'constructor', defaults).image).toBeUndefined();
    });

    it('skips a default a route could not serve (bucket, key or size), never serving it', () => {
      for (const bad of [
        { ...fallback, bucket: 'files-user1' },
        { ...fallback, bucket: 'constructor' },
        { ...fallback, bucket: 'nope' },
        { ...fallback, key: '../previews/a.png' },
        { ...fallback, key: 'previews/\uD800.png' },
        { ...fallback, key: '' },
        { ...fallback, width: 0 },
        { ...fallback, height: 20_000 },
      ]) {
        expect(isServableImageRef(bad)).toBe(false);
        expect(previewCard({ title: 'T' }, DOMAIN, { [DOMAIN]: bad }).image).toBeUndefined();
      }
      expect(isServableImageRef(fallback)).toBe(true);
    });
  });

  describe('preview fields in the route schemas', () => {
    const base = { path: '/a', type: 'r2' as const, target: 'a.pdf' };

    it('create takes the fields and strips a client image size', () => {
      const parsed = CreateRouteInputSchema.parse({
        ...base,
        previewTitle: 'T',
        previewImageBucket: '',
        previewImageWidth: 5,
        previewVideoWidth: 640,
        previewVideoHeight: 360,
      });
      expect(parsed).toMatchObject({
        previewTitle: 'T',
        previewImageBucket: '',
        previewVideoWidth: 640,
      });
      expect(parsed).not.toHaveProperty('previewImageWidth');
      expect(
        CreateRouteInputSchema.parse({ ...base, previewImageBucket: 'assets' }).previewImageBucket,
      ).toBe('assets');
    });

    it('refuses over-long text, a bucket with no custom domain and a bad video size', () => {
      for (const fields of [
        { previewTitle: 'x'.repeat(121) },
        { previewDescription: 'x'.repeat(241) },
        { previewImageBucket: 'files-user1' },
        { previewImageKey: 'k'.repeat(1025) },
        { previewVideoWidth: 0 },
        { previewVideoWidth: 1.5 },
        { previewVideoWidth: 7681 },
      ]) {
        expect(CreateRouteInputSchema.safeParse({ ...base, ...fields }).success).toBe(false);
      }
      const refused = CreateRouteInputSchema.safeParse({
        ...base,
        previewImageBucket: 'files-user1',
      });
      expect(refused.error?.issues[0]?.message).toBe(previewImageBucketError());
    });

    it('update clears a video size with null; create does not take null', () => {
      expect(UpdateRouteInputSchema.parse({ previewVideoWidth: null })).toEqual({
        previewVideoWidth: null,
      });
      expect(CreateRouteInputSchema.safeParse({ ...base, previewVideoWidth: null }).success).toBe(
        false,
      );
    });

    it('the MCP tool schemas read a string size and take null on update only', () => {
      expect(
        CreateRouteToolInputSchema.parse({ ...base, domain: DOMAIN, previewVideoWidth: '1280' })
          .previewVideoWidth,
      ).toBe(1280);
      expect(
        UpdateRouteToolInputSchema.parse({ path: '/a', domain: DOMAIN, previewVideoHeight: null })
          .previewVideoHeight,
      ).toBeNull();
      expect(
        CreateRouteToolInputSchema.safeParse({ ...base, domain: DOMAIN, previewVideoWidth: null })
          .success,
      ).toBe(false);
    });

    it('the response schema reads stored preview fields by type only', () => {
      const stored = { ...base, createdAt: 1, updatedAt: 1 };
      // Off-shape but well-typed: readable (whether it is served is decided later)
      for (const fields of [
        { previewTitle: '' },
        { previewTitle: 'x'.repeat(500) },
        { previewImageWidth: 0 },
        { previewTitle: 'T', previewImageWidth: 1200 },
        { previewImageBucket: 'not-a-bucket' },
      ]) {
        expect(RouteSchema.safeParse({ ...stored, ...fields }).success).toBe(true);
      }
      for (const fields of [{ previewTitle: 3 }, { previewVideoHeight: 2.5 }]) {
        expect(RouteSchema.safeParse({ ...stored, ...fields }).success).toBe(false);
      }
    });
  });
});

describe('isCardEligibleFile', () => {
  const r2 = { type: 'r2', path: '/report' };

  it('a single-file r2 route of a non-image file', () => {
    expect(isCardEligibleFile(r2, 'application/pdf')).toBe(true);
    expect(isCardEligibleFile({ type: 'r2' }, '')).toBe(true);
  });

  it.each([
    ['a redirect', { type: 'redirect', path: '/report' }, 'text/html'],
    ['a wildcard route', { ...r2, path: '/docs/*' }, 'text/html'],
    ['an image file', r2, ' IMAGE/PNG'],
  ])('is false for %s', (_label, route, contentType) => {
    expect(isCardEligibleFile(route, contentType)).toBe(false);
  });
});

describe('dropOrphanPreviewImageSize', () => {
  it('drops a size with no complete image beside it, in place, and keeps one beside an image', () => {
    for (const record of [
      { previewImageWidth: 1200, previewImageHeight: 630 },
      { previewImageBucket: 'assets', previewImageWidth: 1200, previewImageHeight: 630 },
      { previewImageKey: 'a.png', previewImageWidth: 1200 },
      { previewImageBucket: '', previewImageKey: 'a.png', previewImageHeight: 630 },
    ] as Record<string, unknown>[]) {
      dropOrphanPreviewImageSize(record);
      expect(record).not.toHaveProperty('previewImageWidth');
      expect(record).not.toHaveProperty('previewImageHeight');
    }
    const kept: Record<string, unknown> = {
      previewImageBucket: 'assets',
      previewImageKey: 'a.png',
      previewImageWidth: 1200,
      previewImageHeight: 630,
    };
    dropOrphanPreviewImageSize(kept);
    expect(kept).toMatchObject({ previewImageWidth: 1200, previewImageHeight: 630 });
  });
});
