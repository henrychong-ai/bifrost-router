import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { clearAllRoutes, seedRoute } from './helpers';

/**
 * Bare `/api` is a system path, never a route (v1.39.0). The admin API mount
 * answers it first without a key (401) or off the admin host (404), but a
 * request that carries the key fell through to the KV catch-all, which served
 * a route or the service binding stored at `/api` with the key-bearing
 * request (the dashboard proxy adds the key to whatever it forwards).
 */
const ADMIN_HOST = 'example.com';
const API_KEY = 'test-api-key-12345';
const MARKER = 'https://dest.example.net/from-route';

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

describe('bare /api is never routed', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await seedRoute({ path: '/api', type: 'redirect', target: MARKER, enabled: true }, ADMIN_HOST);
  });

  it('answers 404 with the admin key, never the route or the service binding', async () => {
    const binding = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('<title>Site</title>', { headers: { 'Content-Type': 'text/html' } }),
    );
    const testEnv = {
      ...env,
      ADMIN_API_DOMAIN: ADMIN_HOST,
      EXAMPLE_SITE: { fetch: binding } as unknown as Fetcher,
    } as unknown as Bindings;
    for (const target of ['/api', '/api?x=1']) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await worker.fetch(
          new Request(`https://${ADMIN_HOST}${target}`, {
            method,
            redirect: 'manual',
            headers: { 'X-Admin-Key': API_KEY },
          }),
          testEnv,
          ctx,
        );
        expect({ target, method, status: response.status }).toEqual({
          target,
          method,
          status: 404,
        });
        expect(response.headers.get('location')).toBeNull();
        await response.body?.cancel();
      }
    }
    expect(binding).not.toHaveBeenCalled();

    // Control: the same binding answers an ordinary path with no route
    const other = await worker.fetch(
      new Request(`https://${ADMIN_HOST}/about`, { redirect: 'manual' }),
      testEnv,
      ctx,
    );
    expect(other.status).toBe(200);
    expect(binding).toHaveBeenCalledTimes(1);
  });

  it('still answers 401 without the key and 404 off the admin host', async () => {
    const testEnv = { ...env, ADMIN_API_DOMAIN: ADMIN_HOST } as unknown as Bindings;
    const unauthenticated = await worker.fetch(
      new Request(`https://${ADMIN_HOST}/api`, { redirect: 'manual' }),
      testEnv,
      ctx,
    );
    expect(unauthenticated.status).toBe(401);
    await seedRoute(
      { path: '/api', type: 'redirect', target: MARKER, enabled: true },
      'links.example.com',
    );
    const offHost = await worker.fetch(
      new Request('https://links.example.com/api', {
        redirect: 'manual',
        headers: { 'X-Admin-Key': API_KEY },
      }),
      testEnv,
      ctx,
    );
    expect(offHost.status).toBe(404);
    expect(offHost.headers.get('location')).toBeNull();
  });
});
