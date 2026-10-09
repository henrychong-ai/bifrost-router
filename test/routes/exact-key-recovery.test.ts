/**
 * The exact-key recovery of an unreadable route record (v1.38.0):
 * `DELETE /api/routes?recover=invalid` deletes exactly the listed key, and only
 * when the record there cannot be read. `normalizePath()` is not idempotent,
 * so the ordinary delete of a listed legacy key (`/p?x` → `/p`, `/Promo` →
 * `/promo`) would reach a different, valid route. The purge uses the stored
 * path as it is, percent-encoded, never normalised again.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRouteAtExactKey, recoverInvalidRoute } from '../../src/kv/routes';
import { routeKey } from '../../src/kv/schema';
import { adminRoutes, routeKeyNotNormalizedMessage } from '../../src/routes/admin';
import { type AppEnv, CLOUDFLARE_ZONE_IDS } from '../../src/types';
import {
  clearAllRoutes,
  createAuditLogsTable,
  createSettlingExecutionContext,
  requestBodyText,
} from '../helpers';

const DOMAIN = 'links.example.com';
const headers = { 'X-Admin-Key': 'test-api-key-12345' };
const UNREADABLE = '{"path":"/x","type":"redirect"';
const VALID = JSON.stringify({ path: '/promo', type: 'redirect', target: 'https://example.com/' });

const app = new Hono<AppEnv>().route('/api', adminRoutes);

/** A DELETE through the admin API, settled, with the purge URLs it posted. */
async function del(query: string) {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await app.fetch(
    new Request(`https://example.com/api/routes?${query}`, { method: 'DELETE', headers }),
    { ...env, CLOUDFLARE_API_TOKEN: 'test-cloudflare-api-token' },
    ctx,
  );
  await settled();
  return response;
}

const enc = encodeURIComponent;

describe('exact-key recovery of an unreadable route record', () => {
  let purged: string[] = [];
  beforeAll(() => {
    CLOUDFLARE_ZONE_IDS['example.com'] = 'test-zone-id';
  });
  afterAll(() => {
    delete CLOUDFLARE_ZONE_IDS['example.com'];
  });
  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
    await env.DB.prepare('DELETE FROM audit_logs').run();
    purged = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/purge_cache')) {
          purged.push(...(JSON.parse(requestBodyText(init)) as { files: string[] }).files);
        }
        return Response.json({ success: true });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['/Promo', '/Promo'],
    ['/p?x', '/p%3Fx'],
    ['/promo/', '/promo/'],
  ])(
    'deletes the unreadable %s and keeps the valid /promo or /p beside it',
    async (stored, purgedPath) => {
      await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
      await env.ROUTES.put(
        routeKey(DOMAIN, '/p'),
        JSON.stringify({ path: '/p', type: 'redirect', target: 'https://example.com/p' }),
      );
      await env.ROUTES.put(routeKey(DOMAIN, stored), UNREADABLE);

      const response = await del(`path=${enc(stored)}&domain=${DOMAIN}&recover=invalid`);
      expect(response.status).toBe(200);
      expect(await env.ROUTES.get(routeKey(DOMAIN, stored))).toBeNull();
      // The valid routes the ordinary delete would have normalised to survive
      expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBe(VALID);
      expect(await env.ROUTES.get(routeKey(DOMAIN, '/p'))).not.toBeNull();
      // The stored path as it is, percent-encoded, never normalised again
      expect(purged).toEqual([`https://${DOMAIN}${purgedPath}`]);
      const row = await env.DB.prepare(
        "SELECT details FROM audit_logs WHERE action = 'delete' ORDER BY id DESC LIMIT 1",
      ).first<{ details: string }>();
      expect(JSON.parse(row?.details ?? '{}')).toEqual({
        key: routeKey(DOMAIN, stored),
        state: 'invalid',
        recovery: true,
      });
    },
  );

  it('refuses a readable record at that exact key and deletes nothing', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
    const response = await del(`path=/promo&domain=${DOMAIN}&recover=invalid`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'ROUTE_RECORD_READABLE',
      message:
        'The route at this key can be read: delete it with the ordinary delete, not the recovery.',
    });
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBe(VALID);
    expect(purged).toEqual([]);
  });

  it('answers 404 for an empty key, never resolving an alias to another record', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), UNREADABLE);
    const response = await del(`path=/Promo&domain=${DOMAIN}&recover=invalid`);
    expect(response.status).toBe(404);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBe(UNREADABLE);
  });

  it('refuses any other recover value and a path without a leading slash', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/Promo'), UNREADABLE);
    expect((await del(`path=/Promo&domain=${DOMAIN}&recover=yes`)).status).toBe(400);
    expect((await del(`path=Promo&domain=${DOMAIN}&recover=invalid`)).status).toBe(400);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/Promo'))).toBe(UNREADABLE);
  });

  it('a wildcard key is deleted and keeps the documented no-purge limitation', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/Docs/*'), UNREADABLE);
    const response = await del(`path=${enc('/Docs/*')}&domain=${DOMAIN}&recover=invalid`);
    expect(response.status).toBe(200);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/Docs/*'))).toBeNull();
    expect(purged).toEqual([]);
  });

  it('the ordinary delete keeps normalising', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
    const response = await del(`path=/Promo/&domain=${DOMAIN}`);
    expect(response.status).toBe(200);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBeNull();
  });

  // v1.41.2: the ordinary delete refuses a path that does not round-trip, as
  // every other write does; it resolved `/p?x` to `/p` and deleted that route
  it.each([
    ['/p?x', 'Route path must not contain ? or #, or a double-encoded %'],
    ['/p#x', 'Route path must not contain ? or #, or a double-encoded %'],
    ['/p%253Fx', 'Route path must not contain ? or #, or a double-encoded %'],
  ])(
    'the ordinary delete refuses %s and the route it normalises to survives',
    async (quoted, error) => {
      const LIVE = JSON.stringify({
        path: '/p',
        type: 'redirect',
        target: 'https://example.com/p',
      });
      await env.ROUTES.put(routeKey(DOMAIN, '/p'), LIVE);
      await env.ROUTES.put(routeKey(DOMAIN, '/p%3Fx'), LIVE);
      const response = await del(`path=${enc(quoted)}&domain=${DOMAIN}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ success: false, error });
      expect(await env.ROUTES.get(routeKey(DOMAIN, '/p'))).toBe(LIVE);
      expect(await env.ROUTES.get(routeKey(DOMAIN, '/p%3Fx'))).toBe(LIVE);
      expect(purged).toEqual([]);
      const audited = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'delete'",
      ).first<{ n: number }>();
      expect(audited?.n).toBe(0);
    },
  );

  // v1.41.2: a path not in normalised form never deletes the route it
  // normalises to while a record is stored at that exact key, readable or not
  it.each([
    [
      'readable',
      JSON.stringify({ path: '/Promo', type: 'redirect', target: 'https://example.com/' }),
    ],
    ['unreadable', UNREADABLE],
  ])(
    'the ordinary delete of a %s legacy /Promo beside a live /promo is refused',
    async (state, legacy) => {
      await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
      await env.ROUTES.put(routeKey(DOMAIN, '/Promo'), legacy);
      expect((await getRouteAtExactKey(env.ROUTES, DOMAIN, '/Promo')).status).toBe(
        state === 'readable' ? 'ok' : 'invalid',
      );
      const response = await del(`path=/Promo&domain=${DOMAIN}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        error: 'ROUTE_KEY_NOT_NORMALIZED',
        message: routeKeyNotNormalizedMessage('/promo'),
      });
      expect(routeKeyNotNormalizedMessage('/promo')).toContain('would delete /promo instead');
      expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBe(VALID);
      expect(await env.ROUTES.get(routeKey(DOMAIN, '/Promo'))).toBe(legacy);
      expect(purged).toEqual([]);
      const audited = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'delete'",
      ).first<{ n: number }>();
      expect(audited?.n).toBe(0);
    },
  );

  it('a legacy key with no route at its normalised path is refused too, not a 404', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo/'), VALID);
    const response = await del(`path=${enc('/promo/')}&domain=${DOMAIN}`);
    expect(response.status).toBe(409);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo/'))).toBe(VALID);
  });

  it('a non-normalised path with nothing at its exact key still deletes the normalised route', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
    const response = await del(`path=${enc('/promo/')}&domain=${DOMAIN}`);
    expect(response.status).toBe(200);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBeNull();
    expect(purged).toEqual([]);
  });

  it('an already-normalised path deletes with one read and no exact-key read', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
    const reads: string[] = [];
    const counted = new Proxy(env.ROUTES, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (property === 'get' || property === 'getWithMetadata') reads.push(String(args[0]));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const { ctx, settled } = createSettlingExecutionContext();
    const response = await app.fetch(
      new Request(`https://example.com/api/routes?path=/promo&domain=${DOMAIN}`, {
        method: 'DELETE',
        headers,
      }),
      { ...env, ROUTES: counted, CLOUDFLARE_API_TOKEN: 'test-cloudflare-api-token' },
      ctx,
    );
    await settled();
    expect(response.status).toBe(200);
    expect(reads).toEqual([routeKey(DOMAIN, '/promo')]);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBeNull();
  });

  it('the recovery delete still addresses a non-round-trip key exactly', async () => {
    await env.ROUTES.put(
      routeKey(DOMAIN, '/p'),
      JSON.stringify({ path: '/p', type: 'redirect', target: 'https://example.com/p' }),
    );
    await env.ROUTES.put(routeKey(DOMAIN, '/p?x'), UNREADABLE);
    expect((await del(`path=${enc('/p?x')}&domain=${DOMAIN}`)).status).toBe(400);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/p?x'))).toBe(UNREADABLE);
    expect((await del(`path=${enc('/p?x')}&domain=${DOMAIN}&recover=invalid`)).status).toBe(200);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/p?x'))).toBeNull();
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/p'))).not.toBeNull();
  });

  it('recoverInvalidRoute names its outcome for the exact key', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), VALID);
    await env.ROUTES.put(routeKey(DOMAIN, '/Promo'), UNREADABLE);
    expect(await recoverInvalidRoute(env.ROUTES, DOMAIN, '/missing')).toBe('missing');
    expect(await recoverInvalidRoute(env.ROUTES, DOMAIN, '/promo')).toBe('readable');
    expect(await recoverInvalidRoute(env.ROUTES, DOMAIN, '/Promo')).toBe('deleted');
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/promo'))).toBe(VALID);
  });
});
