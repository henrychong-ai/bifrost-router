import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

/**
 * `GET /api/changelog`.
 *
 * The dashboard used to compile CHANGELOG.md into its JS bundle, which the
 * dashboard host serves with no credential check. The document is now served
 * only from the admin chain, so the same API-key middleware that guards route
 * management guards it.
 */
describe('GET /api/changelog', () => {
  const validApiKey = 'test-api-key-12345';
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };
  const app = new Hono<AppEnv>().route('/api', adminRoutes);

  const request = (headers: HeadersInit = {}) =>
    app.fetch(new Request('http://example.com/api/changelog', { headers }), testEnv);

  it('serves the markdown to an authenticated caller', async () => {
    const response = await request({ 'X-Admin-Key': validApiKey });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    const body = await response.text();
    expect(body).toMatch(/^# Changelog/);
    expect(body).toMatch(/^## v\d+\.\d+\.\d+ \(/m);
  });

  it('is cached per-browser only — a shared cache would republish it', async () => {
    const response = await request({ 'X-Admin-Key': validApiKey });

    const cacheControl = response.headers.get('Cache-Control');
    expect(cacheControl).toBe('private, max-age=300');
    expect(cacheControl).not.toContain('public');
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await request();
    expect(response.status).toBe(401);
  });

  it('refuses a wrong key', async () => {
    const response = await request({ 'X-Admin-Key': 'wrong-key' });
    expect(response.status).toBe(401);
  });
});
