import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { handleR2 } from '../../src/handlers/r2';
import type { AppEnv, KVRouteConfig } from '../../src/types';

// Mock R2 object
function createMockR2Object(body: string, contentType?: string): R2ObjectBody {
  return {
    key: 'test-file.txt',
    version: 'v1',
    size: body.length,
    etag: '"abc123"',
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

describe('handleR2', () => {
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

      // Should either return 400 for blocked, or sanitize and attempt get
      // Based on our implementation, it sanitizes and uses the sanitized key
      // The mock will return null (file not found) for sanitized key
      expect(mockBucket.get).toHaveBeenCalledWith('etc/passwd');
    });
  });
});
