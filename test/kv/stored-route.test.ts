/**
 * Stored route records validated on read (v1.38.0). The guard is
 * hand-written for the hot path; these tests keep it in step with the shared
 * RouteSchema and pin how an invalid record is handled: never served, never
 * a fall-through to a broader route, never listed, logged as fixed text only,
 * and still deletable.
 */
import { env } from 'cloudflare:test';
import { RouteSchema } from '@bifrost/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchRoute } from '../../src/kv/lookup';
import {
  deleteRoute,
  findRoutesByR2Target,
  getAllRoutes,
  getAllRoutesAllDomains,
  getRoute,
  getRouteSafe,
  getRouteState,
  InvalidStoredRouteError,
  migrateRoute,
  seedRoutes,
  transferRoute,
  updateRoute,
} from '../../src/kv/routes';
import { isRouteKey, routeKey } from '../../src/kv/schema';
import {
  isStoredRoute,
  STORED_ROUTE_FIELDS,
  STORED_ROUTE_REQUIRED,
} from '../../src/kv/stored-route';
import { createMockRoute } from '../fixtures';
import { clearRoutes } from '../helpers';

const DOMAIN = 'links.example.com';
const OTHER = 'secondary.example.net';
const secret = 'hunter2-target-token';

describe('isStoredRoute parity with RouteSchema', () => {
  it('classifies every RouteSchema field, and nothing else', () => {
    const classified = [
      'type',
      ...STORED_ROUTE_REQUIRED,
      ...Object.values(STORED_ROUTE_FIELDS).flat(),
    ].toSorted();
    expect(classified).toEqual(Object.keys(RouteSchema.shape).toSorted());
  });

  it('accepts every record the schema accepts, minimal and full', () => {
    const minimal = RouteSchema.parse({
      path: '/a',
      type: 'redirect',
      target: 'https://example.com',
      createdAt: 1,
      updatedAt: 2,
    });
    const full = RouteSchema.parse({
      path: '/files/*',
      type: 'r2',
      target: 'docs/',
      statusCode: 301,
      preserveQuery: false,
      preservePath: true,
      cacheControl: 'no-store',
      hostHeader: 'example.com',
      forceDownload: true,
      bucket: 'files',
      enabled: false,
      createdAt: 1,
      updatedAt: 2,
    });
    for (const record of [minimal, full, createMockRoute()]) {
      expect(isStoredRoute(JSON.parse(JSON.stringify(record)))).toBe(true);
    }
  });

  it('accepts legacy records: optional fields absent or null, extra fields kept', () => {
    expect(
      isStoredRoute({
        path: '/legacy',
        type: 'proxy',
        target: 'https://example.com',
        statusCode: null,
        bucket: null,
        cacheControl: null,
        legacyField: { anything: true },
      }),
    ).toBe(true);
    // A target over today's write cap still reads back
    expect(
      isStoredRoute({
        path: '/long',
        type: 'redirect',
        target: `https://example.com/${'a'.repeat(9000)}`,
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', ['/a', 'redirect']],
    ['an unknown type', { path: '/a', type: 'script', target: 'x' }],
    ['a missing target', { path: '/a', type: 'redirect' }],
    ['a numeric path', { path: 7, type: 'redirect', target: 'x' }],
    ['a string statusCode', { path: '/a', type: 'redirect', target: 'x', statusCode: '301' }],
    ['a string enabled', { path: '/a', type: 'redirect', target: 'x', enabled: 'false' }],
    ['a numeric bucket', { path: '/a', type: 'r2', target: 'x', bucket: 3 }],
    ['an object hostHeader', { path: '/a', type: 'proxy', target: 'x', hostHeader: {} }],
    ['a string createdAt', { path: '/a', type: 'redirect', target: 'x', createdAt: 'today' }],
  ])('refuses %s', (_label, value) => {
    expect(isStoredRoute(value)).toBe(false);
  });
});

describe('isRouteKey', () => {
  it.each([
    ['example.com:/a', true],
    ['links.example.com:/', true],
    ['secondary.example.net:/blog/*', true],
    ['ratelimit:feedback:203.0.113.9', false],
    ['ratelimit:example.com:/a', false],
    ['qr:example.com:office-wifi', false],
    ['example.com:a', false],
    [':/a', false],
    ['nocolon', false],
    ['localhost:/a', false],
  ])('%s is a route key: %s', (key, expected) => {
    expect(isRouteKey(key)).toBe(expected);
  });
});

const fixedLog = (key: string) =>
  JSON.stringify({ level: 'warn', message: 'boundary-invalid-value', category: 'route', key });

describe('an invalid stored route', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await clearRoutes(DOMAIN);
    await clearRoutes(OTHER);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const expectFixedLog = (key = routeKey(DOMAIN, '/bad')) => {
    expect(warn).toHaveBeenCalledWith(fixedLog(key));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  };

  it.each([
    ['not JSON', `{"path":"/bad","target":"https://example.com/?token=${secret}"`],
    ['the wrong shape', JSON.stringify({ path: '/bad', type: 'script', target: secret })],
    ['a JSON string', JSON.stringify(secret)],
  ])('a record that is %s is not served, not listed and not returned', async (_label, stored) => {
    await env.ROUTES.put(routeKey(DOMAIN, '/bad'), stored);
    const good = createMockRoute({ path: '/good' });
    await env.ROUTES.put(routeKey(DOMAIN, '/good'), JSON.stringify(good));

    expect(await matchRoute(env.ROUTES, DOMAIN, '/bad')).toBeNull();
    expect(await getRoute(env.ROUTES, DOMAIN, '/bad')).toBeNull();
    expect(await getRouteSafe(env.ROUTES, DOMAIN, '/bad')).toEqual({ success: true, data: null });
    expect(await getRouteState(env.ROUTES, DOMAIN, '/bad')).toEqual({ status: 'invalid' });
    expect((await getAllRoutes(env.ROUTES, DOMAIN)).map(route => route.path)).toEqual(['/good']);
    expect(
      (await getAllRoutesAllDomains(env.ROUTES)).map(route => `${route.domain}${route.path}`),
    ).toEqual([`${DOMAIN}/good`]);
    expectFixedLog();
  });

  it('an invalid exact record under a public wildcard is a 404, the wildcard not served', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/docs/private'), '{"broken"');
    const wildcard = createMockRoute({ path: '/docs/*', target: 'https://example.com/docs' });
    await env.ROUTES.put(routeKey(DOMAIN, '/docs/*'), JSON.stringify(wildcard));
    expect(await matchRoute(env.ROUTES, DOMAIN, '/docs/private')).toBeNull();
    expectFixedLog(routeKey(DOMAIN, '/docs/private'));
    // Another path under the wildcard is still served
    expect((await matchRoute(env.ROUTES, DOMAIN, '/docs/public'))?.path).toBe('/docs/*');
  });

  it('an invalid wildcard record is a 404 rather than a broader wildcard', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/docs/*'), JSON.stringify({ type: 'script' }));
    const root = createMockRoute({ path: '/*', target: 'https://example.com/root' });
    await env.ROUTES.put(routeKey(DOMAIN, '/*'), JSON.stringify(root));
    expect(await matchRoute(env.ROUTES, DOMAIN, '/docs/a')).toBeNull();
    expectFixedLog(routeKey(DOMAIN, '/docs/*'));
    expect((await matchRoute(env.ROUTES, DOMAIN, '/other'))?.path).toBe('/*');
  });

  it('a request path whose exact key is over 512 bytes reads as absent, never a KV error', async () => {
    const root = createMockRoute({ path: '/*', target: 'https://example.com/root' });
    await env.ROUTES.put(routeKey(DOMAIN, '/*'), JSON.stringify(root));
    const long = `/${'a'.repeat(600)}`;
    expect((await matchRoute(env.ROUTES, DOMAIN, long))?.path).toBe('/*');
    await env.ROUTES.delete(routeKey(DOMAIN, '/*'));
    expect(await matchRoute(env.ROUTES, DOMAIN, long)).toBeNull();
    expect(await getRoute(env.ROUTES, DOMAIN, long)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('valid records are served without any log', async () => {
    const route = createMockRoute({ path: '/ok' });
    await env.ROUTES.put(routeKey(DOMAIN, '/ok'), JSON.stringify(route));
    expect(await matchRoute(env.ROUTES, DOMAIN, '/ok')).toEqual(route);
    expect(warn).not.toHaveBeenCalled();
  });

  it('can still be deleted, which is the recovery', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/bad'), '{"broken"');
    expect(await deleteRoute(env.ROUTES, DOMAIN, '/bad')).toBe(true);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/bad'))).toBeNull();
    expect(await deleteRoute(env.ROUTES, DOMAIN, '/bad')).toBe(false);
  });

  it('is never merged with an update, migrated, transferred or overwritten', async () => {
    const key = routeKey(DOMAIN, '/bad');
    await env.ROUTES.put(key, '{"broken"');
    const good = createMockRoute({ path: '/good' });
    await env.ROUTES.put(routeKey(DOMAIN, '/good'), JSON.stringify(good));

    await expect(
      updateRoute(env.ROUTES, DOMAIN, '/bad', { enabled: false }),
    ).rejects.toBeInstanceOf(InvalidStoredRouteError);
    await expect(migrateRoute(env.ROUTES, DOMAIN, '/bad', '/moved')).rejects.toBeInstanceOf(
      InvalidStoredRouteError,
    );
    await expect(migrateRoute(env.ROUTES, DOMAIN, '/good', '/bad')).rejects.toBeInstanceOf(
      InvalidStoredRouteError,
    );
    await expect(transferRoute(env.ROUTES, DOMAIN, OTHER, '/bad')).rejects.toBeInstanceOf(
      InvalidStoredRouteError,
    );
    await env.ROUTES.put(routeKey(OTHER, '/good'), '{"broken"');
    await expect(transferRoute(env.ROUTES, DOMAIN, OTHER, '/good')).rejects.toBeInstanceOf(
      InvalidStoredRouteError,
    );
    // A seed skips it like an existing route
    const seeded = await seedRoutes(env.ROUTES, DOMAIN, [
      {
        path: '/bad',
        type: 'redirect',
        target: 'https://example.com/new',
        preserveQuery: true,
        preservePath: false,
        forceDownload: false,
        enabled: true,
      },
    ]);
    expect(seeded).toMatchObject({ created: 0, skipped: 1 });
    // Nothing above wrote anything
    expect(await env.ROUTES.get(key)).toBe('{"broken"');
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/moved'))).toBeNull();
    expect(JSON.parse((await env.ROUTES.get(routeKey(DOMAIN, '/good'))) ?? 'null')).toEqual(good);
  });

  it('the refusal is a fixed 409 ROUTE_RECORD_INVALID', async () => {
    const error = new InvalidStoredRouteError();
    const response = error.getResponse();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'ROUTE_RECORD_INVALID',
      message:
        'This route is stored in a shape that cannot be read. Delete it and create it again.',
    });
  });
});

describe('listings never read a key that is not route-shaped', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await clearRoutes(DOMAIN);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    warn.mockRestore();
    await env.ROUTES.delete('ratelimit:feedback:203.0.113.9');
    await env.ROUTES.delete(`${DOMAIN}:not-a-path`);
  });

  it('skips rate-limit entries and malformed keys before reading or logging them', async () => {
    await env.ROUTES.put('ratelimit:feedback:203.0.113.9', '{"count":1,"resetAt":1}');
    await env.ROUTES.put(`${DOMAIN}:not-a-path`, 'not json either');
    const route = createMockRoute({ path: '/files/a', type: 'r2', target: 'a.pdf' });
    await env.ROUTES.put(routeKey(DOMAIN, '/files/a'), JSON.stringify(route));
    const get = vi.spyOn(env.ROUTES, 'get');
    try {
      expect((await getAllRoutesAllDomains(env.ROUTES)).map(r => r.path)).toEqual(['/files/a']);
      expect((await getAllRoutes(env.ROUTES, DOMAIN)).map(r => r.path)).toEqual(['/files/a']);
      expect((await findRoutesByR2Target(env.ROUTES, 'files', 'a.pdf')).map(r => r.path)).toEqual([
        '/files/a',
      ]);
      const readKeys = get.mock.calls.map(call => String(call[0]));
      expect(readKeys).not.toContain('ratelimit:feedback:203.0.113.9');
      expect(readKeys).not.toContain(`${DOMAIN}:not-a-path`);
    } finally {
      get.mockRestore();
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('203.0.113.9');
    expect(warn).not.toHaveBeenCalled();
  });
});
