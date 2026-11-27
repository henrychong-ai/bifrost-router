/**
 * v1.48.0: the route lists (`GET /api/routes`, per domain and across all
 * domains) name each route by the domain and path of its KV key, where it is
 * served, never by the record's own `path` field, which a record written
 * outside the API could hold differently. `findRoutesByR2Target` (Storage's
 * associated routes, the preview-image refusal) names routes the same way.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRoute } from '../../src/kv/routes';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { clearAllRoutes, createSettlingExecutionContext } from '../helpers';

const API_KEY = 'test-api-key-12345'; // gitleaks:allow

interface ListedRoute {
  domain: string;
  path: string;
  target: string;
}

async function listRoutes(query: string): Promise<ListedRoute[]> {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await new Hono<AppEnv>().route('/api', adminRoutes).fetch(
    new Request(`http://bifrost.example.com/api/routes${query}`, {
      headers: { 'X-Admin-Key': API_KEY },
    }),
    { ...env, ADMIN_API_DOMAIN: 'bifrost.example.com' },
    ctx,
  );
  await settled();
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { routes: ListedRoute[] } }).data.routes;
}

describe('route lists name a route where it is served (v1.48.0)', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await createRoute(env.ROUTES, 'links.example.com', {
      path: '/served-here',
      type: 'redirect',
      target: 'https://example.com/a',
    });
    // The record's `path` field now disagrees with its key
    const stored = JSON.parse((await env.ROUTES.get('links.example.com:/served-here')) ?? '{}');
    await env.ROUTES.put(
      'links.example.com:/served-here',
      JSON.stringify({ ...stored, path: '/record-says' }),
    );
    // A record that agrees with its key, as the API writes them
    await createRoute(env.ROUTES, 'secondary.example.net', {
      path: '/plain',
      type: 'redirect',
      target: 'https://example.com/b',
    });
  });

  it('per domain: the path of the KV key', async () => {
    const routes = await listRoutes('?domain=links.example.com');
    expect(routes).toEqual([
      expect.objectContaining({
        domain: 'links.example.com',
        path: '/served-here',
        target: 'https://example.com/a',
      }),
    ]);
  });

  it('across all domains: the domain and path of each KV key', async () => {
    const routes = await listRoutes('');
    expect(routes.map(({ domain, path }) => `${domain}${path}`).toSorted()).toEqual([
      'links.example.com/served-here',
      'secondary.example.net/plain',
    ]);
  });

  it('a search matches the served path, not the record field', async () => {
    expect((await listRoutes('?search=served-here')).map(route => route.path)).toEqual([
      '/served-here',
    ]);
    expect(await listRoutes('?search=record-says')).toEqual([]);
    expect(
      (await listRoutes('?domain=links.example.com&search=served-here')).map(route => route.path),
    ).toEqual(['/served-here']);
  });
});
