import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { handleR2 } from '../../src/handlers/r2';
import r2HandlerSource from '../../src/handlers/r2.ts?raw';
import type { AppEnv, KVRouteConfig } from '../../src/types';

/**
 * Mock R2 object.
 *
 * `etag` is the RAW unquoted hash and `httpEtag` its quoted RFC-valid form —
 * exactly how R2 shapes them. Mocking both as the same quoted string is the
 * blindness that let `ETag: object.etag` ship: every assertion passed while the
 * served entity-tag was invalid and R2 rejected it on the next revalidation.
 */
function createMockR2Object(body: string, contentType?: string): R2ObjectBody {
  return {
    key: 'test-file.txt',
    version: 'v1',
    // BYTE length, not UTF-16 code units: R2 reports bytes, and `.length` would
    // under-report any non-ASCII fixture — masking exactly the Content-Length
    // arithmetic these tests exist to pin.
    size: new TextEncoder().encode(body).length,
    etag: 'abc123',
    httpEtag: '"abc123"',
    checksums: {},
    uploaded: new Date(),
    httpMetadata: contentType ? { contentType } : undefined,
    customMetadata: {},
    range: undefined,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
    json: async () => JSON.parse(body),
    blob: async () => new Blob([body]),
    writeHttpMetadata: () => {},
  } as unknown as R2ObjectBody;
}

/**
 * Mock R2Object WITHOUT a body — what `bucket.get()` returns when an `onlyIf`
 * precondition is not met. `etag` raw, `httpEtag` quoted, as R2 returns them.
 */
function createMockR2ObjectHead(etag = 'abc123', size = 4096): R2Object {
  return {
    key: 'test-file.txt',
    version: 'v1',
    size,
    etag,
    httpEtag: `"${etag}"`,
    checksums: {},
    uploaded: new Date('2026-01-01T00:00:00Z'),
    httpMetadata: { contentType: 'text/plain' },
    customMetadata: {},
    range: undefined,
    writeHttpMetadata: () => {},
  } as unknown as R2Object;
}

/** Mock R2ObjectBody carrying a satisfied range, as R2 returns for a Range GET. */
function createMockR2RangeObject(
  body: string,
  range: R2Range,
  size: number,
  uploaded?: Date,
): R2ObjectBody {
  return {
    ...(createMockR2Object(body, 'text/plain') as unknown as Record<string, unknown>),
    size,
    range,
    ...(uploaded ? { uploaded } : {}),
  } as unknown as R2ObjectBody;
}

/** Fixed upload timestamp for the If-Range date-form cases. */
const UPLOADED_AT = new Date('2026-02-03T04:05:06Z');

/** Minimal ExecutionContext so the handler's `waitUntil(cache.put(...))` runs. */
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

describe('handleR2', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('bucket configuration', () => {
    it('returns 500 when bucket not configured', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media'),
        { ENVIRONMENT: 'development' }, // No FILES_BUCKET
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe('R2 bucket not configured: files');
    });
  });

  describe('file retrieval', () => {
    it('returns 404 when file not found', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'nonexistent.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(null),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('File not found');
    });

    it('serves file with correct content type from metadata', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'document.pdf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('PDF content', 'application/pdf');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/pdf');
      expect(response.headers.get('ETag')).toBe('"abc123"');
    });

    it('infers content type from extension when no metadata', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'image.png',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('PNG data');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Content-Type')).toBe('image/png');
    });

    it('uses default cache control when not specified', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('text content', 'text/plain');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });

    it('uses custom cache control when specified', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        cacheControl: 'public, max-age=86400',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('text content', 'text/plain');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
    });
  });

  describe('content disposition', () => {
    it('forces download for PDF files', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/download',
        type: 'r2',
        target: 'docs/report.pdf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('PDF content', 'application/pdf');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/download', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/download'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="report.pdf"');
    });

    it('forces download for ZIP files', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/download',
        type: 'r2',
        target: 'archive.zip',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('ZIP content', 'application/zip');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/download', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/download'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Content-Disposition')).toContain('attachment');
    });

    it('does not force download for images', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/image',
        type: 'r2',
        target: 'photo.jpg',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('JPEG data', 'image/jpeg');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/image', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/image'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Content-Disposition')).toBeNull();
    });

    it('forces download when forceDownload=true even for images', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/image',
        type: 'r2',
        target: 'photo.jpg',
        forceDownload: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('JPEG data', 'image/jpeg');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/image', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/image'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="photo.jpg"');
    });

    it('displays PDF inline when forceDownload=false', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/document',
        type: 'r2',
        target: 'docs/report.pdf',
        forceDownload: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('PDF content', 'application/pdf');
      const mockBucket = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      app.get('/document', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/document'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      // forceDownload=false should override the default PDF download behavior
      expect(response.headers.get('Content-Disposition')).toBeNull();
    });
  });

  describe('path traversal protection', () => {
    it('rejects path traversal attempts', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/evil',
        type: 'r2',
        target: '../../../etc/passwd',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn(),
      };

      app.get('/evil', c => handleR2(c, route));

      await app.fetch(new Request('http://localhost/evil'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      // Strict validation rejects keys with dangerous patterns (path traversal)
      // The bucket.get should never be called since the key is rejected upfront
      expect(mockBucket.get).not.toHaveBeenCalled();
    });
  });

  describe('conditional requests', () => {
    it('forwards the request headers to R2 as onlyIf and range options', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };

      app.get('/media', c => handleR2(c, route));

      await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-None-Match': '"abc123"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      const options = mockBucket.get.mock.calls[0][1] as R2GetOptions;
      expect((options.onlyIf as Headers).get('if-none-match')).toBe('"abc123"');
      expect((options.range as Headers).get('if-none-match')).toBe('"abc123"');
    });

    it('returns 304 with no body when If-None-Match matches the stored etag', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        cacheControl: 'public, max-age=600',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-None-Match': '"abc123"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(304);
      expect(response.headers.get('ETag')).toBe('"abc123"');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=600');
      expect(response.headers.get('Content-Length')).toBeNull();
      expect(await response.text()).toBe('');
    });

    it('returns 412 when an If-Match precondition fails', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-Match': '"stale-etag"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(412);
      expect(response.headers.get('Last-Modified')).toBeTruthy();
      expect(await response.text()).toBe('');
    });

    it('returns 412 for a weak If-Match tag against the same strong etag', async () => {
      // RFC 9110 §13.1.1: If-Match uses the STRONG comparison function, so
      // `W/"abc123"` must NOT match the strong etag `"abc123"`.
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-Match': 'W/"abc123"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(412);
    });

    it('returns 412 when a bare If-Unmodified-Since predates the upload', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { 'If-Unmodified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(412);
    });

    it('emits Last-Modified on a 304', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const head = createMockR2ObjectHead();
      const mockBucket = { get: vi.fn().mockResolvedValue(head) };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-None-Match': '"abc123"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(304);
      expect(response.headers.get('Last-Modified')).toBe(head.uploaded.toUTCString());
    });

    it('returns 304 when If-Match is satisfied but If-None-Match also matches', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { 'If-Match': '"abc123"', 'If-None-Match': '"abc123"' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(304);
    });

    it('serves the body for If-Match: * against an existing object', async () => {
      // `*` matches any existing representation, so R2 satisfies the
      // precondition and returns a BODY — the response is an ordinary 200.
      // (Mocking a bodiless head here would be an impossible scenario: R2 only
      // withholds the body when the precondition FAILED.)
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-Match': '*' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('text content');
    });

    it('does not write a 304 into the edge cache', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };
      const putSpy = vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-None-Match': '"abc123"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        ctx,
      );
      await settled();

      expect(response.status).toBe(304);
      expect(putSpy).not.toHaveBeenCalled();
    });
  });

  describe('range requests', () => {
    it('returns 206 with Content-Range for a closed byte range', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(
            createMockR2RangeObject('a'.repeat(1024), { offset: 0, length: 1024 }, 4096),
          ),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=0-1023' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
      expect(response.headers.get('Content-Length')).toBe('1024');
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
      expect((await response.text()).length).toBe(1024);
    });

    it('returns 206 with the full remainder for an open-ended byte range', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(createMockR2RangeObject('a'.repeat(3072), { offset: 1024 }, 4096)),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=1024-' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 1024-4095/4096');
      expect(response.headers.get('Content-Length')).toBe('3072');
      // The declared length must match the bytes actually delivered — a
      // Content-Length larger than the body hangs conforming clients.
      expect((await response.arrayBuffer()).byteLength).toBe(3072);
    });

    it('returns 206 with an absolute range for a suffix byte range', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(createMockR2RangeObject('a'.repeat(512), { suffix: 512 }, 4096)),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=-512' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 3584-4095/4096');
      expect(response.headers.get('Content-Length')).toBe('512');
      expect((await response.arrayBuffer()).byteLength).toBe(512);
    });

    it('clamps a suffix larger than the object to the whole object', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(createMockR2RangeObject('a'.repeat(4096), { suffix: 9999 }, 4096)),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=-9999' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 0-4095/4096');
      expect(response.headers.get('Content-Length')).toBe('4096');
    });

    it('advertises Accept-Ranges on a full 200 response', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };
      vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    });

    it('serves the full object when R2 rejects an unsatisfiable range', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockRejectedValueOnce(new Error('The requested range is not satisfiable'))
          .mockResolvedValueOnce(createMockR2Object('text content', 'text/plain')),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=99999-' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('text content');
      expect((mockBucket.get.mock.calls[1][1] as R2GetOptions).range).toBeUndefined();
    });

    it('does not write a 206 into the edge cache', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(
            createMockR2RangeObject('a'.repeat(1024), { offset: 0, length: 1024 }, 4096),
          ),
      };
      const putSpy = vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=0-1023' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        ctx,
      );
      await settled();

      expect(response.status).toBe(206);
      expect(putSpy).not.toHaveBeenCalled();
    });

    it('writes a full 200 into the edge cache under a URL-only key', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };
      vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
      const putSpy = vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://localhost/media'),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect((putSpy.mock.calls[0][0] as Request).url).toBe('http://localhost/media');
    });
  });

  describe('edge cache key', () => {
    it('skips the cache lookup entirely when a Range header is present', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(
            createMockR2RangeObject('a'.repeat(1024), { offset: 0, length: 1024 }, 4096),
          ),
      };
      const matchSpy = vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=0-1023' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(matchSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['If-None-Match', '"abc123"'],
      ['If-Modified-Since', 'Mon, 01 Jan 2024 00:00:00 GMT'],
      ['If-Match', '"abc123"'],
      ['If-Unmodified-Since', 'Mon, 01 Jan 2099 00:00:00 GMT'],
    ])('skips the cache lookup when %s is present', async (header, value) => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };
      const matchSpy = vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      await app.fetch(new Request('http://localhost/media', { headers: { [header]: value } }), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(matchSpy).not.toHaveBeenCalled();
    });

    it('builds the cache key from the URL only, without request headers', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };
      const matchSpy = vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      await app.fetch(
        new Request('http://localhost/media', { headers: { 'X-Probe': 'should-not-be-in-key' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(matchSpy).toHaveBeenCalledTimes(1);
      const cacheKey = matchSpy.mock.calls[0][0] as Request;
      expect(cacheKey.url).toBe('http://localhost/media');
      expect(cacheKey.headers.get('X-Probe')).toBeNull();
    });
  });

  describe('Last-Modified', () => {
    it('emits Last-Modified on a full 200', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('text content', 'text/plain');
      const mockBucket = { get: vi.fn().mockResolvedValue(mockObject) };
      vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Last-Modified')).toBe(mockObject.uploaded.toUTCString());
    });

    it('emits Last-Modified on a 206', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'big.bin',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(
            createMockR2RangeObject(
              'a'.repeat(1024),
              { offset: 0, length: 1024 },
              4096,
              UPLOADED_AT,
            ),
          ),
      };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=0-1023' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Last-Modified')).toBe(UPLOADED_AT.toUTCString());
    });
  });

  describe('entity tags', () => {
    // R2 exposes the raw (unquoted) hash as `etag` and the RFC-valid quoted
    // form as `httpEtag`. Emitting the raw one produced an invalid entity-tag
    // that R2 itself rejects when a client echoes it back in If-None-Match
    // ("Invalid ETag in if-none-match header") — a 500 on every revalidation.
    // Every mock in this file keeps the two DISTINCT for exactly that reason.
    it('emits the quoted httpEtag on a 200, not the raw etag', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockObject = createMockR2Object('text content', 'text/plain');
      const mockBucket = { get: vi.fn().mockResolvedValue(mockObject) };
      vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(mockObject.etag).toBe('abc123');
      expect(response.headers.get('ETag')).toBe('"abc123"');
      expect(response.headers.get('ETag')).not.toBe(mockObject.etag);
    });

    it('emits the quoted httpEtag on a 304', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const head = createMockR2ObjectHead();
      const mockBucket = { get: vi.fn().mockResolvedValue(head) };

      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-None-Match': '"abc123"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(head.etag).toBe('abc123');
      expect(response.status).toBe(304);
      expect(response.headers.get('ETag')).toBe('"abc123"');
    });

    it('matches the quoted form the client echoes back, not the raw hash', async () => {
      // The client only ever sees `httpEtag`, so the comparison must succeed
      // against the QUOTED value even though R2's own `etag` is the bare hash.
      // Meaningful here precisely because the two mock fields are deliberately
      // different strings.
      //
      // Satisfied If-Match → R2 returns the body → 200. The failing
      // counterpart below drives the bodiless shape R2 actually produces.
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const object = createMockR2Object('text content', 'text/plain');
      expect(object.etag).toBe('abc123');
      expect(object.httpEtag).toBe('"abc123"');

      const mockBucket = { get: vi.fn().mockResolvedValue(object) };
      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-Match': object.httpEtag } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('text content');
    });

    it('412s for the failing counterpart, where R2 withholds the body', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'file.txt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = { get: vi.fn().mockResolvedValue(createMockR2ObjectHead()) };
      app.get('/media', c => handleR2(c, route));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-Match': '"a-different-etag"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(412);
      expect(await response.text()).toBe('');
    });
  });

  describe('If-Range', () => {
    const rangeRoute: KVRouteConfig = {
      path: '/media',
      type: 'r2',
      target: 'big.bin',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    /** A satisfied 1024-byte slice of a 4096-byte object uploaded at UPLOADED_AT. */
    function sliceObject(): R2ObjectBody {
      return createMockR2RangeObject(
        'a'.repeat(1024),
        { offset: 0, length: 1024 },
        4096,
        UPLOADED_AT,
      );
    }

    it('serves 206 when the entity-tag validator still matches', async () => {
      const app = new Hono<AppEnv>();
      const mockBucket = { get: vi.fn().mockResolvedValue(sliceObject()) };

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-1023', 'If-Range': '"abc123"' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
      expect(mockBucket.get).toHaveBeenCalledTimes(1);
    });

    it('ignores the Range and serves a full 200 when the entity-tag is stale', async () => {
      const app = new Hono<AppEnv>();
      const full = createMockR2Object('a'.repeat(4096), 'text/plain');
      const mockBucket = {
        get: vi.fn().mockResolvedValueOnce(sliceObject()).mockResolvedValueOnce(full),
      };

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-1023', 'If-Range': '"stale-etag"' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(await response.text()).toBe('a'.repeat(4096));
      // The re-read drops the range but KEEPS onlyIf, so a concurrent overwrite
      // cannot slip a representation past a passing If-Match.
      expect(mockBucket.get).toHaveBeenCalledTimes(2);
      const reReadOptions = mockBucket.get.mock.calls[1][1] as R2GetOptions;
      expect(reReadOptions.range).toBeUndefined();
      expect(reReadOptions.onlyIf).toBeInstanceOf(Headers);
    });

    it('treats a weak If-Range entity-tag as stale (strong comparison)', async () => {
      const app = new Hono<AppEnv>();
      const full = createMockR2Object('a'.repeat(4096), 'text/plain');
      const mockBucket = {
        get: vi.fn().mockResolvedValueOnce(sliceObject()).mockResolvedValueOnce(full),
      };

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-1023', 'If-Range': 'W/"abc123"' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(mockBucket.get).toHaveBeenCalledTimes(2);
    });

    it('serves 206 when the date-form validator matches the upload time exactly', async () => {
      const app = new Hono<AppEnv>();
      const mockBucket = { get: vi.fn().mockResolvedValue(sliceObject()) };

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-1023', 'If-Range': UPLOADED_AT.toUTCString() },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(mockBucket.get).toHaveBeenCalledTimes(1);
    });

    it('serves a full 200 when the date-form validator does not match exactly', async () => {
      // Date form is an EXACT match, not before/after: one second later is stale.
      const app = new Hono<AppEnv>();
      const full = createMockR2Object('a'.repeat(4096), 'text/plain');
      const mockBucket = {
        get: vi.fn().mockResolvedValueOnce(sliceObject()).mockResolvedValueOnce(full),
      };
      const laterByOneSecond = new Date(UPLOADED_AT.getTime() + 1000).toUTCString();

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-1023', 'If-Range': laterByOneSecond },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(mockBucket.get).toHaveBeenCalledTimes(2);
    });

    it('IGNORES an unusable If-Range value and still serves the 206', async () => {
      // RFC 9110 §13.1.5: a recipient MUST ignore an If-Range it cannot
      // evaluate. Treating garbage as a mismatch would let any client (or
      // attacker) disable seeking by sending a junk validator.
      const app = new Hono<AppEnv>();
      const mockBucket = { get: vi.fn().mockResolvedValue(sliceObject()) };

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-1023', 'If-Range': 'not-a-date-or-etag' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
      expect(mockBucket.get).toHaveBeenCalledTimes(1);
    });

    it('404s when the If-Range re-read is refused by the surviving precondition', async () => {
      // Deliberate fail-closed: the object was overwritten between the two
      // reads into something the caller's If-Match no longer matches, so R2
      // returns a bodiless head. Serving the discarded slice would splice the
      // OLD bytes into a copy the client already knows is stale.
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValueOnce(sliceObject())
          .mockResolvedValueOnce(createMockR2ObjectHead()),
      };

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: {
            Range: 'bytes=0-1023',
            'If-Range': '"stale-etag"',
            'If-Match': '"abc123"',
          },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(404);
      expect(mockBucket.get).toHaveBeenCalledTimes(2);
    });

    it('ignores If-Range entirely when no Range accompanies it', async () => {
      // RFC 9110 §13.1.5. One read, ordinary 200 — and the request is NOT
      // treated as conditional, so it still uses the edge cache.
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
      };
      const matchSpy = vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      app.get('/media', c => handleR2(c, rangeRoute));

      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-Range': '"stale-etag"' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );

      expect(response.status).toBe(200);
      expect(mockBucket.get).toHaveBeenCalledTimes(1);
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('servedR2Key attribution', () => {
    it('sets servedR2Key before the cache lookup, not after it', () => {
      // Source-ordering guard: the cache HIT branch returns early, so a
      // `c.set('servedR2Key', …)` placed below `cache.match(…)` leaves every
      // cached serve attributed to `route.target` in file_downloads.
      const setIndex = r2HandlerSource.indexOf("c.set('servedR2Key'");
      const matchIndex = r2HandlerSource.indexOf('cache.match(');
      expect(setIndex).toBeGreaterThan(-1);
      expect(matchIndex).toBeGreaterThan(-1);
      expect(setIndex).toBeLessThan(matchIndex);
    });

    it('records the served key on a cache HIT', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'docs/report.pdf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = { get: vi.fn() };
      vi.spyOn(caches.default, 'match').mockResolvedValue(
        new Response('cached body', { headers: { 'Content-Type': 'application/pdf' } }),
      );

      let servedKey: string | undefined;
      app.get('/media', async c => {
        const response = await handleR2(c, route);
        servedKey = c.get('servedR2Key');
        return response;
      });

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.headers.get('X-Cache-Status')).toBe('HIT');
      expect(mockBucket.get).not.toHaveBeenCalled();
      expect(servedKey).toBe('docs/report.pdf');
    });

    it('records the route target verbatim for an object-mode route', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/media',
        type: 'r2',
        target: 'docs/report.pdf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2Object('PDF content', 'application/pdf')),
      };
      vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

      let servedKey: string | undefined;
      app.get('/media', async c => {
        const response = await handleR2(c, route);
        servedKey = c.get('servedR2Key');
        return response;
      });

      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });

      expect(response.status).toBe(200);
      expect(servedKey).toBe(route.target);
    });
  });

  describe('degraded reads and edge cases', () => {
    const baseRoute: KVRouteConfig = {
      path: '/media',
      type: 'r2',
      target: 'file.txt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    it('degrades to an unconditional read when R2 rejects a conditional-only request', async () => {
      // Deploy-day reality: every object stored before this release was served
      // with the RAW unquoted etag, so returning clients echo it back as
      // If-None-Match and R2 rejects it. Must be a 200, never a 500.
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi
          .fn()
          .mockRejectedValueOnce(new Error('Invalid ETag in if-none-match header'))
          .mockResolvedValueOnce(createMockR2Object('hello world')),
      };
      app.get('/media', c => handleR2(c, baseRoute));
      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { 'If-None-Match': 'abc123' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hello world');
      expect(mockBucket.get).toHaveBeenCalledTimes(2);
      // The recovery read is unconditional — no options at all.
      expect(mockBucket.get.mock.calls[1][1]).toBeUndefined();
    });

    it('degrades stepwise when BOTH range and conditional options are rejected', async () => {
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi
          .fn()
          .mockRejectedValueOnce(new Error('Invalid ETag in if-none-match header'))
          .mockRejectedValueOnce(new Error('Invalid ETag in if-none-match header'))
          .mockResolvedValueOnce(createMockR2Object('hello world')),
      };
      app.get('/media', c => handleR2(c, baseRoute));
      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { 'If-None-Match': 'abc123', Range: 'bytes=0-4' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );
      expect(response.status).toBe(200);
      expect(mockBucket.get).toHaveBeenCalledTimes(3);
      expect(mockBucket.get.mock.calls[2][1]).toBeUndefined();
    });

    it('rethrows an R2 failure on a plain unconditional read', async () => {
      // Degradation is scoped to unusable REQUEST OPTIONS. A genuine R2 outage
      // on a request that carried neither a Range nor a precondition has
      // nothing to degrade to and must surface, not be swallowed as a 200.
      const app = new Hono<AppEnv>();
      const mockBucket = { get: vi.fn().mockRejectedValue(new Error('R2 unavailable')) };
      vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
      app.get('/media', c => handleR2(c, baseRoute));

      // Hono's default error boundary turns the propagated throw into a 500 —
      // the point is that it is NOT silently degraded into a 200.
      const response = await app.fetch(new Request('http://localhost/media'), {
        ENVIRONMENT: 'development',
        FILES_BUCKET: mockBucket as unknown as R2Bucket,
      });
      expect(response.status).toBe(500);
      expect(mockBucket.get).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when the If-Range full re-read finds the object gone', async () => {
      // A stale If-Range validator + vanished object must NEVER produce a 206
      // built from the old slice (silent splice corruption) — fail closed.
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValueOnce(createMockR2RangeObject('slice', { offset: 0, length: 5 }, 4096))
          .mockResolvedValueOnce(null),
      };
      app.get('/media', c => handleR2(c, baseRoute));
      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: { Range: 'bytes=0-4', 'If-Range': '"stale-etag"' },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Range')).toBeNull();
    });

    it('ignores If-Unmodified-Since when a present If-Match passes (RFC 9110 §13.2.2)', async () => {
      // Bodiless head = R2 declined the read. If-Match matches, so per
      // §13.2.2 step 2 the (stale) date validator must be IGNORED → 304.
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi.fn().mockResolvedValue(createMockR2ObjectHead()),
      };
      app.get('/media', c => handleR2(c, baseRoute));
      const response = await app.fetch(
        new Request('http://localhost/media', {
          headers: {
            'If-Match': '"abc123"',
            'If-Unmodified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
          },
        }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );
      expect(response.status).toBe(304);
    });

    it('clamps an over-long reported range length to the remaining object size', async () => {
      const app = new Hono<AppEnv>();
      const mockBucket = {
        get: vi
          .fn()
          .mockResolvedValue(
            createMockR2RangeObject('abcdef', { offset: 4090, length: 999999 }, 4096),
          ),
      };
      app.get('/media', c => handleR2(c, baseRoute));
      const response = await app.fetch(
        new Request('http://localhost/media', { headers: { Range: 'bytes=4090-' } }),
        { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
      );
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Length')).toBe('6');
      expect(response.headers.get('Content-Range')).toBe('bytes 4090-4095/4096');
      expect((await response.arrayBuffer()).byteLength).toBe(6);
    });
  });

  /**
   * Conditional-request behaviours where a naive implementation could fail
   * open. This one is deliberately strict at each; the suite pins all seven.
   */
  describe('deliberate strictness (RFC conformance)', () => {
    const baseRoute: KVRouteConfig = {
      path: '/media',
      type: 'r2',
      target: 'file.txt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    describe('strong preconditions survive a degraded read', () => {
      it('412s when a dropped If-Match would have failed (conditional-only ladder)', async () => {
        // The ladder discards `onlyIf` because ONE validator was unusable.
        // Without restoration, a failing If-Match silently became a full 200 —
        // the caller believes it read the representation it pinned.
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi
            .fn()
            .mockRejectedValueOnce(new Error('Invalid ETag in if-none-match header'))
            .mockResolvedValueOnce(createMockR2Object('hello world')),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            headers: { 'If-None-Match': 'abc123', 'If-Match': '"stale-etag"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(412);
        expect(await response.text()).toBe('');
        expect(response.headers.get('ETag')).toBe('"abc123"');
        expect(response.headers.get('Last-Modified')).toBeTruthy();
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
      });

      it('412s when a dropped If-Match would have failed (both-rejected ladder)', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi
            .fn()
            .mockRejectedValueOnce(new Error('malformed range'))
            .mockRejectedValueOnce(new Error('Invalid ETag in if-match header'))
            .mockResolvedValueOnce(createMockR2Object('hello world')),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            headers: { Range: 'bytes=0-4', 'If-Match': '"stale-etag"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(412);
        expect(mockBucket.get).toHaveBeenCalledTimes(3);
      });

      it('412s when a dropped If-Unmodified-Since would have failed', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi
            .fn()
            .mockRejectedValueOnce(new Error('Invalid ETag in if-none-match header'))
            .mockResolvedValueOnce(createMockR2Object('hello world')),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            headers: {
              'If-None-Match': 'abc123',
              'If-Unmodified-Since': 'Mon, 01 Jan 2001 00:00:00 GMT',
            },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(412);
      });

      it('still serves 200 when the dropped strong precondition would have PASSED', async () => {
        // Restoration must not turn every degraded read into a 412.
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi
            .fn()
            .mockRejectedValueOnce(new Error('Invalid ETag in if-none-match header'))
            .mockResolvedValueOnce(createMockR2Object('hello world')),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            headers: { 'If-None-Match': 'abc123', 'If-Match': '"abc123"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('hello world');
      });

      it('does not re-evaluate when the read was NOT degraded', async () => {
        // A normal read had its preconditions honoured by R2 itself; a second
        // evaluation here would double-apply them.
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi.fn().mockResolvedValue(createMockR2Object('hello world')),
        };
        vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(new Request('http://localhost/media'), {
          ENVIRONMENT: 'development',
          FILES_BUCKET: mockBucket as unknown as R2Bucket,
        });

        expect(response.status).toBe(200);
        expect(mockBucket.get).toHaveBeenCalledTimes(1);
      });
    });

    describe('If-Unmodified-Since is stripped from onlyIf when If-Match is present', () => {
      it('hands R2 only the governing validator (RFC 9110 §13.2.2)', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        await app.fetch(
          new Request('http://localhost/media', {
            headers: {
              'If-Match': '"abc123"',
              'If-Unmodified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
            },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        const options = mockBucket.get.mock.calls[0][1] as R2GetOptions;
        expect((options.onlyIf as Headers).get('if-match')).toBe('"abc123"');
        expect((options.onlyIf as Headers).get('if-unmodified-since')).toBeNull();
        // The RAW headers still drive everything else, so the subordinate
        // validator is only hidden from R2 — not from the request.
        expect((options.range as Headers).get('if-unmodified-since')).toBe(
          'Mon, 01 Jan 2024 00:00:00 GMT',
        );
      });

      it('keeps If-Unmodified-Since when If-Match is absent', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        await app.fetch(
          new Request('http://localhost/media', {
            headers: { 'If-Unmodified-Since': 'Mon, 01 Jan 2099 00:00:00 GMT' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        const options = mockBucket.get.mock.calls[0][1] as R2GetOptions;
        expect((options.onlyIf as Headers).get('if-unmodified-since')).toBe(
          'Mon, 01 Jan 2099 00:00:00 GMT',
        );
      });
    });

    describe('method semantics', () => {
      it('returns 412, never 304, for a failed precondition on a non-GET/HEAD method', async () => {
        // 304 is defined for GET and HEAD only (RFC 9110 §15.4.5).
        const app = new Hono<AppEnv>();
        const mockBucket = { get: vi.fn().mockResolvedValue(createMockR2ObjectHead()) };
        app.post('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            method: 'POST',
            headers: { 'If-None-Match': '"abc123"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(412);
      });

      it('still returns 304 for a failed weak precondition on HEAD', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = { get: vi.fn().mockResolvedValue(createMockR2ObjectHead()) };
        app.all('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            method: 'HEAD',
            headers: { 'If-None-Match': '"abc123"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(304);
      });

      it('withholds the range option on a non-GET method but keeps conditionals', async () => {
        // Range is GET-only (RFC 9110 §14.2).
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi.fn().mockResolvedValue(createMockR2Object('text content', 'text/plain')),
        };
        app.all('/media', c => handleR2(c, baseRoute));

        await app.fetch(
          new Request('http://localhost/media', {
            method: 'HEAD',
            headers: { Range: 'bytes=0-3', 'If-Match': '"abc123"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        const options = mockBucket.get.mock.calls[0][1] as R2GetOptions;
        expect(options.range).toBeUndefined();
        expect((options.onlyIf as Headers).get('if-match')).toBe('"abc123"');
      });

      it('serves a full 200 for a HEAD carrying a Range header', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi
            .fn()
            .mockResolvedValue(
              createMockR2RangeObject('a'.repeat(1024), { offset: 0, length: 1024 }, 4096),
            ),
        };
        app.all('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', {
            method: 'HEAD',
            headers: { Range: 'bytes=0-1023' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Range')).toBeNull();
      });
    });

    describe('If-Match against a missing object', () => {
      it('returns 412, not 404 (RFC 9110 §13.1.1)', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = { get: vi.fn().mockResolvedValue(null) };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', { headers: { 'If-Match': '"abc123"' } }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(412);
        expect(await response.text()).toBe('');
      });

      it('returns 412 for If-Match: * against a missing object', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = { get: vi.fn().mockResolvedValue(null) };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', { headers: { 'If-Match': '*' } }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(412);
      });

      it('still returns the ordinary 404 when no If-Match is present', async () => {
        const app = new Hono<AppEnv>();
        const mockBucket = { get: vi.fn().mockResolvedValue(null) };
        vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(new Request('http://localhost/media'), {
          ENVIRONMENT: 'development',
          FILES_BUCKET: mockBucket as unknown as R2Bucket,
        });

        expect(response.status).toBe(404);
        const data = await response.json();
        expect(data.error).toBe('File not found');
      });
    });

    describe('zero-length resolved range', () => {
      it('returns 416 with an unsatisfied Content-Range instead of an invalid one', async () => {
        // `bytes 4096-4095/4096` is not a valid Content-Range. R2 normally
        // throws on an unsatisfiable range before this, so the guard defends a
        // shape R2 is not expected to produce.
        const app = new Hono<AppEnv>();
        const mockBucket = {
          get: vi
            .fn()
            .mockResolvedValue(createMockR2RangeObject('', { offset: 4096, length: 0 }, 4096)),
        };
        app.get('/media', c => handleR2(c, baseRoute));

        const response = await app.fetch(
          new Request('http://localhost/media', { headers: { Range: 'bytes=4096-' } }),
          { ENVIRONMENT: 'development', FILES_BUCKET: mockBucket as unknown as R2Bucket },
        );

        expect(response.status).toBe(416);
        expect(response.headers.get('Content-Range')).toBe('bytes */4096');
        expect(response.headers.get('Accept-Ranges')).toBe('bytes');
        expect(await response.text()).toBe('');
      });
    });
  });
});
