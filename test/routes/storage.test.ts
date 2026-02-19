import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { ALL_R2_BUCKETS, READ_ONLY_BUCKETS } from '@bifrost/shared';

describe('storage routes', () => {
  const validApiKey = 'test-api-key-12345';

  // Create test env with ADMIN_API_DOMAIN set to enable domain restriction
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'henrychong.com' };

  const app = new Hono<AppEnv>().route('/api', adminRoutes);

  function storageRequest(
    path: string,
    options: RequestInit = {},
    apiKey = validApiKey,
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('X-Admin-Key', apiKey);
    if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return app.fetch(
      new Request(`http://henrychong.com/api/storage${path}`, {
        ...options,
        headers,
      }),
      testEnv,
    );
  }

  // Seed an R2 object directly via the env binding
  async function seedR2Object(
    key: string,
    content: string | ArrayBuffer,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    const bucket = env.FILES_BUCKET;
    await bucket.put(key, content, {
      httpMetadata: { contentType },
    });
  }

  // Clear all R2 objects
  async function clearR2(): Promise<void> {
    const bucket = env.FILES_BUCKET;
    const objects = await bucket.list();
    for (const obj of objects.objects) {
      await bucket.delete(obj.key);
    }
  }

  beforeEach(async () => {
    await clearR2();
  });

  describe('authentication', () => {
    it('rejects requests without API key', async () => {
      const response = await app.fetch(
        new Request('http://henrychong.com/api/storage/buckets'),
        testEnv,
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /storage/buckets', () => {
    it('returns all configured buckets with access levels', async () => {
      const response = await storageRequest('/buckets');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.buckets).toHaveLength(ALL_R2_BUCKETS.length);

      // Verify structure of each bucket
      for (const bucket of data.data.buckets) {
        expect(bucket).toHaveProperty('name');
        expect(bucket).toHaveProperty('access');
        expect(['read-write', 'read-only']).toContain(bucket.access);
      }

      // Verify read-only buckets are marked correctly
      const readOnlyBuckets = data.data.buckets.filter(
        (b: { access: string }) => b.access === 'read-only',
      );
      for (const ro of readOnlyBuckets) {
        expect((READ_ONLY_BUCKETS as readonly string[]).includes(ro.name)).toBe(true);
      }
    });
  });

  describe('GET /storage/:bucket/objects', () => {
    it('lists objects in a bucket', async () => {
      await seedR2Object('test-file.txt', 'hello world', 'text/plain');

      const response = await storageRequest('/files/objects');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.objects.length).toBeGreaterThanOrEqual(1);

      const obj = data.data.objects.find((o: { key: string }) => o.key === 'test-file.txt');
      expect(obj).toBeDefined();
      expect(obj.size).toBe(11); // "hello world" length
    });

    it('filters objects by prefix', async () => {
      await seedR2Object('images/photo.jpg', 'jpg-data', 'image/jpeg');
      await seedR2Object('docs/readme.md', 'markdown', 'text/markdown');

      const response = await storageRequest('/files/objects?prefix=images/&delimiter=');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.objects.every((o: { key: string }) => o.key.startsWith('images/'))).toBe(
        true,
      );
    });

    it('supports cursor pagination', async () => {
      // Seed multiple objects
      for (let i = 0; i < 5; i++) {
        await seedR2Object(`file-${i}.txt`, `content-${i}`, 'text/plain');
      }

      // Request with limit=2
      const response1 = await storageRequest('/files/objects?limit=2&delimiter=');

      expect(response1.status).toBe(200);
      const data1 = await response1.json();
      expect(data1.data.objects.length).toBe(2);

      if (data1.data.truncated) {
        // Use cursor for next page
        const response2 = await storageRequest(
          `/files/objects?limit=2&cursor=${data1.data.cursor}&delimiter=`,
        );

        expect(response2.status).toBe(200);
        const data2 = await response2.json();
        expect(data2.data.objects.length).toBeGreaterThan(0);
      }
    });

    it('returns 404 for invalid bucket name', async () => {
      const response = await storageRequest('/nonexistent-bucket/objects');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /storage/:bucket/meta/:key', () => {
    it('returns object metadata', async () => {
      await seedR2Object('test-meta.txt', 'hello', 'text/plain');

      const response = await storageRequest('/files/meta/test-meta.txt');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.key).toBe('test-meta.txt');
      expect(data.data.size).toBe(5);
      expect(data.data).toHaveProperty('etag');
      expect(data.data).toHaveProperty('uploaded');
    });

    it('returns 404 for non-existent object', async () => {
      const response = await storageRequest('/files/meta/nonexistent.txt');

      expect(response.status).toBe(404);
    });

    it('rejects keys with dangerous patterns', async () => {
      // Use validateR2Key directly via the API - keys with null bytes
      // URL routing resolves ".." before it reaches the handler,
      // so test with patterns that survive URL parsing
      const response = await storageRequest('/files/meta/file%00.txt');

      expect(response.status).toBe(400);
    });
  });

  describe('upload + download round-trip', () => {
    it('uploads then downloads file with matching content', async () => {
      const formData = new FormData();
      formData.append('key', 'round-trip.txt');
      formData.append(
        'file',
        new Blob(['round trip content'], { type: 'text/plain' }),
        'round-trip.txt',
      );

      const uploadResponse = await app.fetch(
        new Request('http://henrychong.com/api/storage/files/upload', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
          body: formData,
        }),
        testEnv,
      );

      expect(uploadResponse.status).toBe(201);
      const uploadData = await uploadResponse.json();
      expect(uploadData.success).toBe(true);

      // Now download
      const downloadResponse = await storageRequest('/files/objects/round-trip.txt');

      expect(downloadResponse.status).toBe(200);
      const content = await downloadResponse.text();
      expect(content).toBe('round trip content');
    });
  });

  describe('POST /storage/:bucket/upload', () => {
    it('rejects upload to read-only bucket (bifrost-backups)', async () => {
      const formData = new FormData();
      formData.append('key', 'test.txt');
      formData.append('file', new Blob(['test'], { type: 'text/plain' }), 'test.txt');

      const response = await app.fetch(
        new Request('http://henrychong.com/api/storage/bifrost-backups/upload', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('read-only');
    });

    it('rejects upload without file', async () => {
      const formData = new FormData();
      formData.append('key', 'test.txt');

      const response = await app.fetch(
        new Request('http://henrychong.com/api/storage/files/upload', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });

    it('rejects duplicate upload without overwrite flag', async () => {
      await seedR2Object('existing.txt', 'content', 'text/plain');

      const formData = new FormData();
      formData.append('key', 'existing.txt');
      formData.append('file', new Blob(['new content'], { type: 'text/plain' }), 'existing.txt');

      const response = await app.fetch(
        new Request('http://henrychong.com/api/storage/files/upload', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(409);
    });
  });

  describe('DELETE /storage/:bucket/objects/:key', () => {
    it('deletes an existing object', async () => {
      await seedR2Object('to-delete.txt', 'delete me', 'text/plain');

      const response = await storageRequest('/files/objects/to-delete.txt', {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify object is gone
      const getResponse = await storageRequest('/files/meta/to-delete.txt');
      expect(getResponse.status).toBe(404);
    });

    it('rejects delete on read-only bucket (bifrost-backups)', async () => {
      const response = await storageRequest('/bifrost-backups/objects/some-file.txt', {
        method: 'DELETE',
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('read-only');
    });

    it('returns 404 for non-existent object', async () => {
      const response = await storageRequest('/files/objects/nonexistent.txt', {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /storage/:bucket/rename', () => {
    it('renames an object (copy + delete)', async () => {
      await seedR2Object('old-name.txt', 'rename me', 'text/plain');

      const response = await storageRequest('/files/rename', {
        method: 'POST',
        body: JSON.stringify({ oldKey: 'old-name.txt', newKey: 'new-name.txt' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Old key should be gone
      const oldResponse = await storageRequest('/files/meta/old-name.txt');
      expect(oldResponse.status).toBe(404);

      // New key should exist
      const newResponse = await storageRequest('/files/meta/new-name.txt');
      expect(newResponse.status).toBe(200);
    });

    it('rejects rename for read-only bucket', async () => {
      const response = await storageRequest('/bifrost-backups/rename', {
        method: 'POST',
        body: JSON.stringify({ oldKey: 'a.txt', newKey: 'b.txt' }),
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('read-only');
    });

    it('returns 409 if destination already exists', async () => {
      await seedR2Object('source.txt', 'source content', 'text/plain');
      await seedR2Object('destination.txt', 'dest content', 'text/plain');

      const response = await storageRequest('/files/rename', {
        method: 'POST',
        body: JSON.stringify({ oldKey: 'source.txt', newKey: 'destination.txt' }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe('PUT /storage/:bucket/metadata/:key', () => {
    it('updates object metadata', async () => {
      await seedR2Object('meta-update.txt', 'content', 'text/plain');

      const response = await storageRequest('/files/metadata/meta-update.txt', {
        method: 'PUT',
        body: JSON.stringify({
          contentType: 'text/html',
          cacheControl: 'public, max-age=3600',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify metadata was updated
      const metaResponse = await storageRequest('/files/meta/meta-update.txt');
      const metaData = await metaResponse.json();
      expect(metaData.data.httpMetadata.contentType).toBe('text/html');
    });

    it('rejects metadata update for read-only bucket', async () => {
      const response = await storageRequest('/bifrost-backups/metadata/some-file.txt', {
        method: 'PUT',
        body: JSON.stringify({ contentType: 'text/html' }),
      });

      expect(response.status).toBe(403);
    });
  });

  describe('path validation', () => {
    it('rejects keys with null bytes in download', async () => {
      const response = await storageRequest('/files/objects/file%00.txt');

      expect(response.status).toBe(400);
    });

    it('rejects keys with null bytes in delete', async () => {
      const response = await storageRequest('/files/objects/file%00.txt', {
        method: 'DELETE',
      });

      expect(response.status).toBe(400);
    });

    it('rejects keys with null bytes in metadata endpoint', async () => {
      const response = await storageRequest('/files/meta/file%00.txt');

      expect(response.status).toBe(400);
    });

    it('rejects hidden component paths via upload key validation', async () => {
      const formData = new FormData();
      formData.append('key', '.git/config');
      formData.append('file', new Blob(['test'], { type: 'text/plain' }), 'config');

      const response = await app.fetch(
        new Request('http://henrychong.com/api/storage/files/upload', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });

    it('rejects leading slash paths via upload key validation', async () => {
      const formData = new FormData();
      formData.append('key', '/etc/passwd');
      formData.append('file', new Blob(['test'], { type: 'text/plain' }), 'passwd');

      const response = await app.fetch(
        new Request('http://henrychong.com/api/storage/files/upload', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });

    it('rejects rename with traversal in newKey', async () => {
      await seedR2Object('rename-test.txt', 'content', 'text/plain');

      const response = await storageRequest('/files/rename', {
        method: 'POST',
        body: JSON.stringify({ oldKey: 'rename-test.txt', newKey: '../escape/file.txt' }),
      });

      expect(response.status).toBe(400);
    });
  });
});
