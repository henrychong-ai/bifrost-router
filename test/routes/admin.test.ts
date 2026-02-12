import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

describe('admin routes', () => {
  const validApiKey = 'test-api-key-12345';

  // Create test env with ADMIN_API_DOMAIN set to enable domain restriction
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'henrychong.com' };

  describe('domain restriction', () => {
    it('returns 404 for requests from non-allowed domains', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://evil.com/api/routes', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Not Found');
    });

    it('returns 404 for requests from link.henrychong.com', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://link.henrychong.com/api/routes', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('allows requests from henrychong.com', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });
  });

  describe('authentication', () => {
    it('rejects requests without API key', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(new Request('http://henrychong.com/api/routes'), testEnv);

      expect(response.status).toBe(401);
    });

    it('rejects requests with invalid API key', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          headers: { 'X-Admin-Key': 'wrong-key' },
        }),
        testEnv,
      );

      expect(response.status).toBe(401);
    });

    it('accepts X-Admin-Key header', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it('accepts Authorization Bearer header', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          headers: { Authorization: `Bearer ${validApiKey}` },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });
  });

  describe('GET /routes', () => {
    it('returns empty routes list initially', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.routes).toEqual([]);
    });
  });

  describe('POST /routes', () => {
    it('creates a redirect route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/github',
            type: 'redirect',
            target: 'https://github.com/test',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/github');
      expect(data.data.type).toBe('redirect');
    });

    it('validates required fields', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/test',
            // missing type and target
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Validation failed');
    });

    it('validates route type', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/test',
            type: 'invalid',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
    });

    it('rejects duplicate paths', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create first route
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/duplicate',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Try to create duplicate
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/duplicate',
            type: 'redirect',
            target: 'https://other.com',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(409);
    });
  });

  describe('GET /routes?path=', () => {
    it('returns existing route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/gettest',
            type: 'proxy',
            target: 'https://api.example.com',
          }),
        }),
        testEnv,
      );

      // Get the route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/gettest', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.path).toBe('/gettest');
    });

    it('returns 404 for non-existent route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/nonexistent', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('handles root path "/" correctly', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create root path route
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Get the root route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.path).toBe('/');
    });
  });

  describe('PUT /routes?path=', () => {
    it('updates existing route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/updatetest',
            type: 'redirect',
            target: 'https://old.example.com',
          }),
        }),
        testEnv,
      );

      // Update the route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/updatetest', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target: 'https://new.example.com',
            statusCode: 301,
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.target).toBe('https://new.example.com');
      expect(data.data.statusCode).toBe(301);
    });

    it('returns 400 when path query parameter is missing', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Path query parameter is required');
    });

    it('returns 404 for non-existent route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/nonexistent', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /routes?path=', () => {
    it('deletes existing route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/deletetest',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Delete the route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/deletetest', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('returns 400 when path query parameter is missing', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Path query parameter is required');
    });

    it('returns 404 for non-existent route', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/nonexistent', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('handles root path "/" deletion correctly', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create root path route
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Delete the root route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  describe('Wildcard route operations', () => {
    it('creates wildcard route with /*', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/*',
            type: 'redirect',
            target: 'https://fallback.example.com',
            statusCode: 302,
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/*');
      expect(data.data.target).toBe('https://fallback.example.com');
    });

    it('gets wildcard route via query parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create the wildcard route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/*',
            type: 'redirect',
            target: 'https://fallback.example.com',
          }),
        }),
        testEnv,
      );

      // Get the wildcard route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/*', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/*');
    });

    it('updates wildcard route via query parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create the wildcard route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/*',
            type: 'redirect',
            target: 'https://fallback.example.com',
            enabled: true,
          }),
        }),
        testEnv,
      );

      // Update (toggle) the wildcard route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/*', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: false,
          }),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/*');
      expect(data.data.enabled).toBe(false);
    });

    it('deletes wildcard route via query parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create the wildcard route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/*',
            type: 'redirect',
            target: 'https://fallback.example.com',
          }),
        }),
        testEnv,
      );

      // Delete the wildcard route using query parameter
      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/*', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('handles prefix wildcard route like /bio*', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create a prefix wildcard route
      const createResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/bio*',
            type: 'redirect',
            target: 'https://bio.example.com',
          }),
        }),
        testEnv,
      );

      expect(createResponse.status).toBe(201);

      // Update the prefix wildcard route
      const updateResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/bio*', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target: 'https://updated-bio.example.com',
          }),
        }),
        testEnv,
      );

      expect(updateResponse.status).toBe(200);
      const data = await updateResponse.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/bio*');
      expect(data.data.target).toBe('https://updated-bio.example.com');

      // Delete the prefix wildcard route
      const deleteResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/bio*', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(deleteResponse.status).toBe(200);
    });

    it('handles wildcard route toggle (enable/disable)', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create wildcard route initially enabled
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/catch-all/*',
            type: 'redirect',
            target: 'https://fallback.example.com',
            enabled: true,
          }),
        }),
        testEnv,
      );

      // Toggle to disabled
      const disableResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/catch-all/*', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        }),
        testEnv,
      );

      expect(disableResponse.status).toBe(200);
      const disableData = await disableResponse.json();
      expect(disableData.success).toBe(true);
      expect(disableData.data.enabled).toBe(false);

      // Toggle back to enabled
      const enableResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/catch-all/*', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: true }),
        }),
        testEnv,
      );

      expect(enableResponse.status).toBe(200);
      const enableData = await enableResponse.json();
      expect(enableData.success).toBe(true);
      expect(enableData.data.enabled).toBe(true);

      // Clean up
      await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/catch-all/*', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
    });
  });

  describe('CORS', () => {
    it('responds to preflight requests from allowed origins', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://henrychong.com',
            'Access-Control-Request-Method': 'POST',
          },
        }),
        testEnv,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://henrychong.com');
    });

    it('rejects preflight requests from disallowed origins', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://evil.com',
            'Access-Control-Request-Method': 'POST',
          },
        }),
        testEnv,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('');
    });
  });

  describe('POST /routes/migrate', () => {
    it('migrates a route to a new path', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/migrate-test',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Migrate the route
      const response = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes/migrate?oldPath=/migrate-test&newPath=/migrated',
          {
            method: 'POST',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/migrated');
      expect(data.data.target).toBe('https://example.com');
      expect(data.message).toContain('migrated');

      // Verify old path no longer exists
      const oldResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/migrate-test', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
      expect(oldResponse.status).toBe(404);

      // Clean up
      await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/migrated', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
    });

    it('preserves createdAt timestamp', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route first
      const createResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/timestamp-test',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );
      const createData = await createResponse.json();
      const originalCreatedAt = createData.data.createdAt;

      // Wait a bit to ensure timestamps would differ
      await new Promise(resolve => setTimeout(resolve, 10));

      // Migrate the route
      const migrateResponse = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes/migrate?oldPath=/timestamp-test&newPath=/timestamp-migrated',
          {
            method: 'POST',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );

      expect(migrateResponse.status).toBe(200);
      const migrateData = await migrateResponse.json();
      expect(migrateData.data.createdAt).toBe(originalCreatedAt);
      expect(migrateData.data.updatedAt).toBeGreaterThan(originalCreatedAt);

      // Clean up
      await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/timestamp-migrated', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
    });

    it('returns 404 for non-existent oldPath', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes/migrate?oldPath=/nonexistent&newPath=/new', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });

    it('returns 409 if newPath already exists', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create two routes
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/conflict-source',
            type: 'redirect',
            target: 'https://source.example.com',
          }),
        }),
        testEnv,
      );

      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/conflict-target',
            type: 'redirect',
            target: 'https://target.example.com',
          }),
        }),
        testEnv,
      );

      // Try to migrate to existing path
      const response = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes/migrate?oldPath=/conflict-source&newPath=/conflict-target',
          {
            method: 'POST',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toContain('already exists');

      // Clean up
      await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/conflict-source', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
      await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/conflict-target', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
    });

    it('returns 400 if paths are the same', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route first
      await app.fetch(
        new Request('http://henrychong.com/api/routes', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/same-path',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      const response = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes/migrate?oldPath=/same-path&newPath=/same-path',
          {
            method: 'POST',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('cannot be the same');

      // Clean up
      await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/same-path', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );
    });

    it('returns 400 if oldPath is missing', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes/migrate?newPath=/new', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('oldPath');
    });

    it('returns 400 if newPath is missing', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/routes/migrate?oldPath=/old', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('newPath');
    });

    it('returns 400 if paths do not start with /', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response1 = await app.fetch(
        new Request('http://henrychong.com/api/routes/migrate?oldPath=no-slash&newPath=/new', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response1.status).toBe(400);
      const data1 = await response1.json();
      expect(data1.error).toContain('oldPath must start with /');

      const response2 = await app.fetch(
        new Request('http://henrychong.com/api/routes/migrate?oldPath=/old&newPath=no-slash', {
          method: 'POST',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response2.status).toBe(400);
      const data2 = await response2.json();
      expect(data2.error).toContain('newPath must start with /');
    });

    it('works with domain parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route on a specific domain
      await app.fetch(
        new Request('http://henrychong.com/api/routes?domain=link.henrychong.com', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/domain-migrate-test',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Migrate the route with domain param
      const response = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes/migrate?oldPath=/domain-migrate-test&newPath=/domain-migrated&domain=link.henrychong.com',
          {
            method: 'POST',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe('/domain-migrated');

      // Clean up
      await app.fetch(
        new Request(
          'http://henrychong.com/api/routes?path=/domain-migrated&domain=link.henrychong.com',
          {
            method: 'DELETE',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );
    });
  });

  describe('Cross-domain mutations', () => {
    it('toggles route on non-default domain with explicit domain param', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route on link.henrychong.com (non-default domain)
      const createResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?domain=link.henrychong.com', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/cross-domain-test',
            type: 'redirect',
            target: 'https://example.com',
            enabled: true,
          }),
        }),
        testEnv,
      );

      expect(createResponse.status).toBe(201);

      // Toggle route with explicit domain - should succeed
      const toggleResponse = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes?path=/cross-domain-test&domain=link.henrychong.com',
          {
            method: 'PUT',
            headers: {
              'X-Admin-Key': validApiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ enabled: false }),
          },
        ),
        testEnv,
      );

      expect(toggleResponse.status).toBe(200);
      const toggleData = await toggleResponse.json();
      expect(toggleData.success).toBe(true);
      expect(toggleData.data.enabled).toBe(false);

      // Clean up
      await app.fetch(
        new Request(
          'http://henrychong.com/api/routes?path=/cross-domain-test&domain=link.henrychong.com',
          {
            method: 'DELETE',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );
    });

    it('returns 404 when updating route without domain param (documents bug fix)', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route on link.henrychong.com
      await app.fetch(
        new Request('http://henrychong.com/api/routes?domain=link.henrychong.com', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/cross-domain-update-test',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Try to update without domain param - falls back to default domain, returns 404
      const updateResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/cross-domain-update-test', {
          method: 'PUT',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        }),
        testEnv,
      );

      // Without domain param, backend defaults to henrychong.com where route doesn't exist
      expect(updateResponse.status).toBe(404);

      // Clean up with correct domain
      await app.fetch(
        new Request(
          'http://henrychong.com/api/routes?path=/cross-domain-update-test&domain=link.henrychong.com',
          {
            method: 'DELETE',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );
    });

    it('returns 404 when deleting route without domain param, succeeds with domain', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route on vanessahung.net
      await app.fetch(
        new Request('http://henrychong.com/api/routes?domain=vanessahung.net', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/cross-domain-delete-test',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Try to delete without domain param - should fail with 404
      const deleteWithoutDomain = await app.fetch(
        new Request('http://henrychong.com/api/routes?path=/cross-domain-delete-test', {
          method: 'DELETE',
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(deleteWithoutDomain.status).toBe(404);

      // Delete with correct domain - should succeed
      const deleteWithDomain = await app.fetch(
        new Request(
          'http://henrychong.com/api/routes?path=/cross-domain-delete-test&domain=vanessahung.net',
          {
            method: 'DELETE',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );

      expect(deleteWithDomain.status).toBe(200);
    });

    it('includes domain field in single-domain list response', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Create route on link.henrychong.com
      await app.fetch(
        new Request('http://henrychong.com/api/routes?domain=link.henrychong.com', {
          method: 'POST',
          headers: {
            'X-Admin-Key': validApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: '/domain-field-test',
            type: 'redirect',
            target: 'https://example.com',
          }),
        }),
        testEnv,
      );

      // Get routes for single domain - domain field should be present on each route
      const listResponse = await app.fetch(
        new Request('http://henrychong.com/api/routes?domain=link.henrychong.com', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();
      expect(listData.success).toBe(true);

      // Find our test route
      const testRoute = listData.data.routes.find(
        (r: { path: string }) => r.path === '/domain-field-test',
      );
      expect(testRoute).toBeDefined();
      expect(testRoute.domain).toBe('link.henrychong.com');

      // Clean up
      await app.fetch(
        new Request(
          'http://henrychong.com/api/routes?path=/domain-field-test&domain=link.henrychong.com',
          {
            method: 'DELETE',
            headers: { 'X-Admin-Key': validApiKey },
          },
        ),
        testEnv,
      );
    });
  });
});
