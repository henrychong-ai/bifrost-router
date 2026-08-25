import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../src/routes/admin';
import { getR2CopySizeLimit } from '../src/routes/storage';
import type { AppEnv } from '../src/types';
import { CLOUDFLARE_ZONE_IDS, R2_BUCKET_CUSTOM_DOMAINS } from '../src/types';

/**
 * Storage API integration tests
 *
 * Uses Cloudflare vitest pool workers with miniflare R2 bindings.
 * The storage routes are mounted under /api/storage/* via adminRoutes.
 */
describe('storage routes', () => {
  const validApiKey = 'test-api-key-12345';

  // Admin domain must match for the domain restriction middleware
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };

  const authHeaders = { 'X-Admin-Key': validApiKey };

  function createApp() {
    return new Hono<AppEnv>().route('/api', adminRoutes);
  }

  /**
   * Helper to upload a file to a bucket via the storage API
   */
  async function uploadFile(
    app: ReturnType<typeof createApp>,
    bucket: string,
    key: string,
    content: string,
    contentType = 'text/plain',
  ) {
    const formData = new FormData();
    formData.append('file', new File([content], 'test.txt', { type: contentType }));
    formData.append('key', key);

    return app.fetch(
      new Request(`http://example.com/api/storage/${bucket}/upload`, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      }),
      testEnv,
    );
  }

  describe('GET /storage/buckets', () => {
    it('returns all configured buckets with access levels', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/buckets', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.buckets).toBeInstanceOf(Array);
      expect(data.data.buckets.length).toBeGreaterThan(0);

      // Check that bifrost-backups is read-only
      const backupsBucket = data.data.buckets.find(
        (b: { name: string }) => b.name === 'bifrost-backups',
      );
      expect(backupsBucket).toBeDefined();
      expect(backupsBucket.access).toBe('read-only');

      // Check that files bucket is read-write
      const filesBucket = data.data.buckets.find((b: { name: string }) => b.name === 'files');
      expect(filesBucket).toBeDefined();
      expect(filesBucket.access).toBe('read-write');
    });
  });

  describe('GET /storage/:bucket/objects', () => {
    it('lists objects in a bucket', async () => {
      const app = createApp();

      // Upload a file first
      await uploadFile(app, 'files', 'list-test/file1.txt', 'content1');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.objects).toBeInstanceOf(Array);
    });

    it('includes httpMetadata and customMetadata in list response', async () => {
      const app = createApp();

      // Upload a file with known content type
      await uploadFile(app, 'files', 'meta-list-test/image.png', 'fake-png', 'image/png');

      const response = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=meta-list-test/&delimiter=',
          {
            headers: authHeaders,
          },
        ),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const obj = data.data.objects.find(
        (o: { key: string }) => o.key === 'meta-list-test/image.png',
      );
      expect(obj).toBeDefined();
      expect(obj.httpMetadata).toBeDefined();
      expect(obj.httpMetadata.contentType).toBe('image/png');
    });

    it('filters objects with prefix', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'prefix-test/a.txt', 'a');
      await uploadFile(app, 'files', 'prefix-test/b.txt', 'b');
      await uploadFile(app, 'files', 'other/c.txt', 'c');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects?prefix=prefix-test/', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      // Only objects under prefix-test/ should be returned
      for (const obj of data.data.objects) {
        expect(obj.key).toMatch(/^prefix-test\//);
      }
    });

    it('paginates with cursor', async () => {
      const app = createApp();

      // Upload enough files
      await uploadFile(app, 'files', 'page/f1.txt', '1');
      await uploadFile(app, 'files', 'page/f2.txt', '2');
      await uploadFile(app, 'files', 'page/f3.txt', '3');

      // Request with limit 1
      const response = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=page/&limit=1&delimiter=',
          {
            headers: authHeaders,
          },
        ),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.objects.length).toBe(1);
      if (data.data.truncated) {
        expect(data.data.cursor).toBeDefined();
      }
    });

    // --- Offset pagination mode (v1.29.0, mirrors the Routes tab) ---

    it('offset mode returns pagination meta and slices the page', async () => {
      const app = createApp();
      for (let i = 0; i < 5; i++) {
        await uploadFile(app, 'files', `offset-page/file${i}.txt`, `x${i}`);
      }

      const page1 = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=offset-page/&delimiter=/&limit=2&offset=0',
          { headers: authHeaders },
        ),
        testEnv,
      );
      const d1 = await page1.json();
      expect(d1.data.meta).toBeDefined();
      expect(d1.data.meta.total).toBe(5);
      expect(d1.data.meta.offset).toBe(0);
      expect(d1.data.meta.limit).toBe(2);
      expect(d1.data.meta.hasMore).toBe(true);
      expect(d1.data.objects).toHaveLength(2);
      expect(d1.data.capped).toBe(false);

      const last = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=offset-page/&delimiter=/&limit=2&offset=4',
          { headers: authHeaders },
        ),
        testEnv,
      );
      const dl = await last.json();
      expect(dl.data.objects).toHaveLength(1);
      expect(dl.data.meta.hasMore).toBe(false);
    });

    it('offset mode paginates folders before files (folders-first)', async () => {
      const app = createApp();
      await uploadFile(app, 'files', 'offset-mix/sub-a/x.txt', 'x');
      await uploadFile(app, 'files', 'offset-mix/sub-b/y.txt', 'y');
      await uploadFile(app, 'files', 'offset-mix/a-file.txt', 'a');
      await uploadFile(app, 'files', 'offset-mix/b-file.txt', 'b');

      const p1 = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=offset-mix/&delimiter=/&limit=2&offset=0',
          { headers: authHeaders },
        ),
        testEnv,
      );
      const r1 = await p1.json();
      expect(r1.data.meta.total).toBe(4);
      expect(r1.data.delimitedPrefixes).toHaveLength(2);
      expect(r1.data.objects).toHaveLength(0);

      const p2 = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=offset-mix/&delimiter=/&limit=2&offset=2',
          { headers: authHeaders },
        ),
        testEnv,
      );
      const r2 = await p2.json();
      expect(r2.data.delimitedPrefixes).toHaveLength(0);
      expect(r2.data.objects).toHaveLength(2);
    });

    it('legacy mode (no offset) returns no pagination meta', async () => {
      const app = createApp();
      await uploadFile(app, 'files', 'offset-legacy/one.txt', '1');
      const response = await app.fetch(
        new Request(
          'http://example.com/api/storage/files/objects?prefix=offset-legacy/&delimiter=/',
          { headers: authHeaders },
        ),
        testEnv,
      );
      const data = await response.json();
      expect(data.data.objects).toHaveLength(1);
      expect(data.data.meta).toBeUndefined();
      expect(data.data.capped).toBeUndefined();
    });

    it('returns 404 for invalid bucket name', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/nonexistent-bucket/objects', {
          headers: authHeaders,
        }),
        testEnv,
      );

      // Invalid bucket returns 404
      expect(response.status).toBe(404);
    });
  });

  describe('GET /storage/:bucket/meta/:key', () => {
    it('returns object metadata', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'meta-test.txt', 'metadata test content', 'text/plain');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/meta-test.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.key).toBe('meta-test.txt');
      expect(data.data.size).toBeGreaterThan(0);
      expect(data.data.etag).toBeDefined();
      expect(data.data.uploaded).toBeDefined();
    });

    it('returns 404 for non-existent object', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/nonexistent.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('rejects invalid R2 key with dangerous patterns', async () => {
      const app = createApp();

      // Keys with hidden components (dot-prefixed segments) are rejected
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/.hidden/secret.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('POST /storage/:bucket/upload + GET /storage/:bucket/objects/:key', () => {
    it('uploads and downloads a file round-trip', async () => {
      const app = createApp();
      const content = 'Hello, R2 storage!';

      // Upload
      const uploadResponse = await uploadFile(app, 'files', 'roundtrip.txt', content, 'text/plain');
      expect(uploadResponse.status).toBe(201);
      const uploadData = await uploadResponse.json();
      expect(uploadData.success).toBe(true);

      // Download
      const downloadResponse = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/roundtrip.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(downloadResponse.status).toBe(200);
      // Quoted httpEtag, never R2's raw unquoted hash — an unquoted entity-tag
      // is invalid, and a client echoing it back makes R2 reject the request.
      expect(downloadResponse.headers.get('ETag')).toMatch(/^"[^"]+"$/);
      const stored = await env.FILES_BUCKET.head('roundtrip.txt');
      expect(downloadResponse.headers.get('ETag')).toBe(stored?.httpEtag);
      expect(downloadResponse.headers.get('ETag')).not.toBe(stored?.etag);
      const downloadedContent = await downloadResponse.text();
      expect(downloadedContent).toBe(content);
    });

    it('rejects upload to read-only bucket (bifrost-backups)', async () => {
      const app = createApp();

      const response = await uploadFile(app, 'bifrost-backups', 'test.txt', 'should fail');
      expect(response.status).toBe(403);
    });

    it('returns 409 when uploading without overwrite to existing key', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'duplicate.txt', 'first');

      const response = await uploadFile(app, 'files', 'duplicate.txt', 'second');
      expect(response.status).toBe(409);
    });

    it('allows overwrite when overwrite=true', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'overwrite-test.txt', 'first');

      // Upload with overwrite
      const formData = new FormData();
      formData.append('file', new File(['second'], 'test.txt', { type: 'text/plain' }));
      formData.append('key', 'overwrite-test.txt');
      formData.append('overwrite', 'true');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/upload', {
          method: 'POST',
          headers: authHeaders,
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(201);
    });

    it('rejects upload with invalid key (path traversal)', async () => {
      const app = createApp();

      const formData = new FormData();
      formData.append('file', new File(['content'], 'test.txt', { type: 'text/plain' }));
      formData.append('key', '../../../etc/passwd');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/upload', {
          method: 'POST',
          headers: authHeaders,
          body: formData,
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('R2 key normalization (v1.27.0, flag-gated)', () => {
    const sanitizeEnv = { ...testEnv, R2_KEY_NORMALIZE: 'sanitize' };

    async function uploadWithEnv(
      app: ReturnType<typeof createApp>,
      bucket: string,
      key: string,
      runEnv: typeof testEnv,
    ) {
      const formData = new FormData();
      formData.append('file', new File(['x'], 'f.txt', { type: 'text/plain' }));
      formData.append('key', key);
      return app.fetch(
        new Request(`http://example.com/api/storage/${bucket}/upload`, {
          method: 'POST',
          headers: authHeaders,
          body: formData,
        }),
        runEnv,
      );
    }

    it('normalizes the upload key to lowercase-kebab when R2_KEY_NORMALIZE=sanitize', async () => {
      const app = createApp();
      const response = await uploadWithEnv(app, 'files', 'My Report.PDF', sanitizeEnv);
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.data.key).toBe('my-report.pdf');
    });

    it('does NOT normalize the upload key when R2_KEY_NORMALIZE is off', async () => {
      const app = createApp();
      const response = await uploadWithEnv(app, 'files', 'Keep-Case.PDF', testEnv);
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.data.key).toBe('Keep-Case.PDF');
    });

    it('normalizes the rename target (source untouched) when sanitize', async () => {
      const app = createApp();
      await uploadFile(app, 'files', 'rename-norm-source.txt', 'content');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'rename-norm-source.txt', newKey: 'My Renamed File.TXT' }),
        }),
        sanitizeEnv,
      );
      expect(response.status).toBe(200);

      // Source gone, normalized target present.
      const oldMeta = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/rename-norm-source.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(oldMeta.status).toBe(404);
      const newMeta = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/my-renamed-file.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(newMeta.status).toBe(200);
    });
  });

  describe('DELETE /storage/:bucket/objects/:key', () => {
    it('deletes an existing object', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'to-delete.txt', 'delete me');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/to-delete.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify it's gone
      const metaResponse = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/to-delete.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(metaResponse.status).toBe(404);
    });

    it('returns 404 for non-existent object', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/nonexistent.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('rejects delete on read-only bucket', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/bifrost-backups/objects/test.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        testEnv,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /storage/:bucket/rename', () => {
    it('renames an object (copy + delete)', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'rename-old.txt', 'rename me');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'rename-old.txt', newKey: 'rename-new.txt' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify old key is gone
      const oldMeta = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/rename-old.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(oldMeta.status).toBe(404);

      // Verify new key exists
      const newMeta = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/rename-new.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(newMeta.status).toBe(200);
    });

    it('returns 409 when destination already exists', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'rename-src.txt', 'source');
      await uploadFile(app, 'files', 'rename-dst.txt', 'destination');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'rename-src.txt', newKey: 'rename-dst.txt' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(409);
    });

    it('returns 404 when source does not exist', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'nonexistent.txt', newKey: 'new.txt' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('rejects rename on read-only bucket', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/bifrost-backups/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'a.txt', newKey: 'b.txt' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /storage/:bucket/move', () => {
    it('moves an object to a different bucket', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'move-test.txt', 'move me');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'move-test.txt', destinationBucket: 'assets' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify source is gone
      const sourceMeta = await app.fetch(
        new Request('http://example.com/api/storage/files/meta/move-test.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(sourceMeta.status).toBe(404);

      // Verify destination exists
      const destMeta = await app.fetch(
        new Request('http://example.com/api/storage/assets/meta/move-test.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(destMeta.status).toBe(200);
    });

    it('moves with a different destination key', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'move-rename.txt', 'move and rename');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: 'move-rename.txt',
            destinationBucket: 'assets',
            destinationKey: 'renamed-in-assets.txt',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);

      // Verify destination has the new key
      const destMeta = await app.fetch(
        new Request('http://example.com/api/storage/assets/meta/renamed-in-assets.txt', {
          headers: authHeaders,
        }),
        testEnv,
      );
      expect(destMeta.status).toBe(200);
    });

    it('returns 404 when source object does not exist', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'nonexistent.txt', destinationBucket: 'assets' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('returns 409 when destination already exists', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'move-conflict-src.txt', 'source');
      await uploadFile(app, 'assets', 'move-conflict-src.txt', 'existing dest');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'move-conflict-src.txt', destinationBucket: 'assets' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(409);
    });

    it('rejects move from read-only bucket', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/bifrost-backups/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'test.txt', destinationBucket: 'files' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(403);
    });

    it('rejects move to read-only bucket', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'move-to-readonly.txt', 'should fail');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: 'move-to-readonly.txt',
            destinationBucket: 'bifrost-backups',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(403);
    });

    it('rejects move to same bucket (destination exists)', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'move-same-bucket.txt', 'same bucket');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'move-same-bucket.txt', destinationBucket: 'files' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(409);
    });

    it('returns 413 when moving object above size limit', async () => {
      const app = createApp();
      const testLimitBytes = getR2CopySizeLimit({ R2_COPY_SIZE_LIMIT_MB: '0.001' });

      await env.FILES_BUCKET.put('large/move-oversized.bin', new ArrayBuffer(testLimitBytes + 1));

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'large/move-oversized.bin', destinationBucket: 'assets' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(413);
    });
  });

  describe('PUT /storage/:bucket/metadata/:key', () => {
    it('updates object metadata', async () => {
      const app = createApp();

      await uploadFile(app, 'files', 'metadata-update.txt', 'content', 'text/plain');

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/metadata-update.txt', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'text/html' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('returns 404 for non-existent object', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/nonexistent.txt', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'text/html' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('rejects metadata update on read-only bucket', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/bifrost-backups/metadata/test.txt', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'text/html' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(403);
    });

    it('rejects invalid R2 key with dangerous patterns', async () => {
      const app = createApp();

      // Keys with hidden components (dot-prefixed segments) are rejected
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/.env', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'text/html' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('authentication', () => {
    it('rejects requests without API key', async () => {
      const app = createApp();

      const response = await app.fetch(
        new Request('http://example.com/api/storage/buckets'),
        testEnv,
      );

      expect(response.status).toBe(401);
    });
  });

  describe('R2 copy size guard', () => {
    // R2_COPY_SIZE_LIMIT_MB is set to '0.001' in vitest.config.ts (~1 KB limit)
    // This allows size guard tests without allocating large buffers
    const testLimitBytes = getR2CopySizeLimit({ R2_COPY_SIZE_LIMIT_MB: '0.001' });

    it('returns 413 when renaming object above size limit', async () => {
      const app = createApp();

      // Seed a file slightly above the test limit directly via binding
      await env.FILES_BUCKET.put('large/oversized.bin', new ArrayBuffer(testLimitBytes + 1));

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'large/oversized.bin', newKey: 'large/renamed.bin' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(413);
      const text = await response.text();
      expect(text).toContain('too large for rename');
    });

    it('returns 413 when updating metadata on object above size limit', async () => {
      const app = createApp();

      await env.FILES_BUCKET.put('large/meta-oversized.bin', new ArrayBuffer(testLimitBytes + 1));

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/large/meta-oversized.bin', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'application/octet-stream' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(413);
      const text = await response.text();
      expect(text).toContain('too large for metadata update');
    });

    it('allows rename for objects at exactly the size limit', async () => {
      const app = createApp();

      // Exactly at the limit should be allowed
      await env.FILES_BUCKET.put('large/exact-limit.bin', new ArrayBuffer(testLimitBytes));

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldKey: 'large/exact-limit.bin',
            newKey: 'large/exact-limit-renamed.bin',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it('allows rename for objects under size limit', async () => {
      const app = createApp();

      await env.FILES_BUCKET.put('large/small.bin', new ArrayBuffer(testLimitBytes - 1));

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'large/small.bin', newKey: 'large/small-renamed.bin' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it('allows metadata update for objects under size limit', async () => {
      const app = createApp();

      await env.FILES_BUCKET.put('large/small-meta.txt', new ArrayBuffer(testLimitBytes - 1), {
        httpMetadata: { contentType: 'text/plain' },
      });

      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/large/small-meta.txt', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'text/html' }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it('does not move source object when rename returns 413', async () => {
      const app = createApp();

      await env.FILES_BUCKET.put('large/413-source.bin', new ArrayBuffer(testLimitBytes + 1));

      await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'large/413-source.bin', newKey: 'large/413-dest.bin' }),
        }),
        testEnv,
      );

      // Source should still exist
      const sourceStillExists = await env.FILES_BUCKET.head('large/413-source.bin');
      expect(sourceStillExists).not.toBeNull();

      // Destination should NOT have been created
      const destCreated = await env.FILES_BUCKET.head('large/413-dest.bin');
      expect(destCreated).toBeNull();
    });

    it('does not modify object when metadata update returns 413', async () => {
      const app = createApp();

      await env.FILES_BUCKET.put('large/413-meta.bin', new ArrayBuffer(testLimitBytes + 1), {
        httpMetadata: { contentType: 'application/octet-stream' },
      });

      await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/large/413-meta.bin', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'text/html' }),
        }),
        testEnv,
      );

      // Object should still exist with original content type
      const obj = await env.FILES_BUCKET.head('large/413-meta.bin');
      expect(obj).not.toBeNull();
      expect(obj?.httpMetadata?.contentType).toBe('application/octet-stream');
    });
  });
  /**
   * Object mutations zone-purge the URLs that served them.
   *
   * Delete / rename / move / metadata-update / overwrite all leave bytes or
   * headers cached at every edge PoP: a deleted object stays readable until
   * `max-age` expires, and a renamed one is readable under BOTH keys. Rename
   * and move purge both sides — the old key still has bytes at the edge, and
   * the new one may hold a cached response for a previous object.
   */
  describe('cache purge on object mutation', () => {
    let purgeBodies: { files: string[] }[] = [];

    // The purge only fires with a token; the default test env has none.
    const purgeEnv = { ...testEnv, CLOUDFLARE_API_TOKEN: 'test-cloudflare-api-token' };

    // This template ships CLOUDFLARE_ZONE_IDS and R2_BUCKET_CUSTOM_DOMAINS
    // EMPTY, so every purge would correctly degrade to purged=0 and prove
    // nothing. Install a representative configuration for this block only.
    beforeAll(() => {
      CLOUDFLARE_ZONE_IDS['example.com'] = 'test-zone-id';
      R2_BUCKET_CUSTOM_DOMAINS.files = ['files.example.com'];
      R2_BUCKET_CUSTOM_DOMAINS.assets = ['assets.example.com'];
    });

    afterAll(() => {
      delete CLOUDFLARE_ZONE_IDS['example.com'];
      delete R2_BUCKET_CUSTOM_DOMAINS.files;
      delete R2_BUCKET_CUSTOM_DOMAINS.assets;
    });

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

    beforeEach(() => {
      purgeBodies = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes('/purge_cache')) {
            purgeBodies.push(JSON.parse(String(init?.body ?? '{}')) as { files: string[] });
          }
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Every URL passed to the CF purge API across all batches. */
    const purgedUrls = () => purgeBodies.flatMap(b => b.files);

    async function seedObject(bucket: string, key: string, body = 'content'): Promise<void> {
      await (env[`${bucket === 'files' ? 'FILES' : 'ASSETS'}_BUCKET`] as R2Bucket).put(key, body, {
        httpMetadata: { contentType: 'text/plain' },
      });
      purgeBodies = [];
    }

    it('purges the object URLs on delete', async () => {
      const app = createApp();
      await seedObject('files', 'purge/del.txt');

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/purge/del.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        purgeEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(purgedUrls()).toContain('https://files.example.com/purge/del.txt');
    });

    it('purges the object URLs on metadata update', async () => {
      const app = createApp();
      await seedObject('files', 'purge/meta.txt');

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/metadata/purge/meta.txt', {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: 'application/pdf' }),
        }),
        purgeEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(purgedUrls()).toContain('https://files.example.com/purge/meta.txt');
    });

    it('purges BOTH the old and new URLs on rename', async () => {
      const app = createApp();
      await seedObject('files', 'purge/before.txt');

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/rename', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldKey: 'purge/before.txt', newKey: 'purge/after.txt' }),
        }),
        purgeEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(purgedUrls()).toContain('https://files.example.com/purge/before.txt');
      expect(purgedUrls()).toContain('https://files.example.com/purge/after.txt');
    });

    it('purges both source and destination URLs on a cross-bucket move', async () => {
      const app = createApp();
      await seedObject('files', 'purge/moved.txt');

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/move', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'purge/moved.txt', destinationBucket: 'assets' }),
        }),
        purgeEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(purgedUrls()).toContain('https://files.example.com/purge/moved.txt');
      expect(purgedUrls()).toContain('https://assets.example.com/purge/moved.txt');
    });

    it('purges on an overwrite upload but not on a first upload', async () => {
      const app = createApp();

      const upload = async (content: string, overwrite: boolean) => {
        const formData = new FormData();
        formData.append('file', new File([content], 'test.txt', { type: 'text/plain' }));
        formData.append('key', 'purge/upload.txt');
        if (overwrite) formData.append('overwrite', 'true');
        const { ctx, settled } = createExecutionContext();
        const response = await app.fetch(
          new Request('http://example.com/api/storage/files/upload', {
            method: 'POST',
            headers: authHeaders,
            body: formData,
          }),
          purgeEnv,
          ctx,
        );
        await settled();
        return response;
      };

      const first = await upload('one', false);
      expect(first.status).toBe(201);
      expect(purgeBodies).toHaveLength(0);

      const second = await upload('two', true);
      expect(second.status).toBe(201);
      expect(purgedUrls()).toContain('https://files.example.com/purge/upload.txt');
    });

    it('purges even when the audit-log path throws', async () => {
      // The purge used to sit INSIDE the audit try block, so anything that threw
      // on the way to `recordAuditLog` silently skipped cache invalidation and
      // stale bytes kept serving from every PoP until max-age expired.
      //
      // `recordAuditLog` swallows its own async failures, so a merely-broken DB
      // would prove nothing. The DB binding here throws on the SECOND access —
      // the comment cleanup earlier in the handler gets a working binding, the
      // audit call does not — which reproduces the real coupling.
      const app = createApp();
      await seedObject('files', 'purge/audit-fail.txt');

      let dbAccesses = 0;
      const brokenEnv = Object.defineProperty({ ...purgeEnv }, 'DB', {
        get() {
          dbAccesses += 1;
          if (dbAccesses > 1) throw new Error('D1 binding unavailable');
          return env.DB;
        },
      });

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/purge/audit-fail.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        brokenEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(dbAccesses).toBeGreaterThan(1);
      expect(purgedUrls()).toContain('https://files.example.com/purge/audit-fail.txt');
    });

    it('survives a Cloudflare API failure without failing the mutation', async () => {
      // An unhandled rejection inside waitUntil can abort the whole invocation.
      const app = createApp();
      await seedObject('files', 'purge/cf-fail.txt');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network unreachable');
        }),
      );
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        errors.push(String(line));
      });

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/purge/cf-fail.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        purgeEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(errors.some(e => e.includes('cache purge failed'))).toBe(true);
    });

    it('degrades silently when no Cloudflare token is configured', async () => {
      const app = createApp();
      await seedObject('files', 'purge/no-token.txt');

      const { ctx, settled } = createExecutionContext();
      const response = await app.fetch(
        new Request('http://example.com/api/storage/files/objects/purge/no-token.txt', {
          method: 'DELETE',
          headers: authHeaders,
        }),
        testEnv,
        ctx,
      );
      await settled();

      expect(response.status).toBe(200);
      expect(purgeBodies).toHaveLength(0);
    });
  });
});
