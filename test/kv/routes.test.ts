import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { lookupRoute } from '../../src/kv/lookup';
import {
  createRoute,
  deleteRoute,
  getAllRoutes,
  getAllRoutesAllDomains,
  getRoute,
  migrateRoute,
  parseRouteKey,
  seedRoutes,
  updateRoute,
} from '../../src/kv/routes';
import { routeKey } from '../../src/kv/schema';
import { clearRoutes } from '../helpers';

/** The record a single-route read found, else null (missing or invalid). */
async function recordAt(...args: Parameters<typeof getRoute>) {
  const read = await getRoute(...args);
  return read.status === 'ok' ? read.value : null;
}

/** The route a lookup serves, else null. */
async function served(...args: Parameters<typeof lookupRoute>) {
  const lookup = await lookupRoute(...args);
  return lookup.status === 'ok' ? lookup.route : null;
}

describe('routes', () => {
  const testDomain = 'test.example.com';

  // Clean up test routes before each test
  beforeEach(async () => {
    // Delete any existing test routes
    const testPaths = [
      '/test-route',
      '/path/with/slashes',
      '/encoded-test',
      '/double-slash',
      '/trailing-test',
      '/seed-test',
      '/hello world',
    ];
    for (const path of testPaths) {
      try {
        await deleteRoute(env.ROUTES, testDomain, path);
      } catch {
        // Ignore errors if route doesn't exist
      }
    }
  });

  describe('path normalization on create', () => {
    it('normalizes URL-encoded paths when creating routes', async () => {
      // Create route with URL-encoded path — createRoute decodes it via normalizePath
      const route = await createRoute(env.ROUTES, testDomain, {
        path: '/hello%20world',
        type: 'redirect',
        target: 'https://example.com',
      });

      // Path should be decoded in the returned route
      expect(route.path).toBe('/hello world');

      // Retrievable with the decoded path (getRoute uses path as-is, no decoding)
      const retrieved = await recordAt(env.ROUTES, testDomain, '/hello world');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.path).toBe('/hello world');
    });

    it('normalizes paths with double slashes when creating routes', async () => {
      const route = await createRoute(env.ROUTES, testDomain, {
        path: '//double-slash',
        type: 'redirect',
        target: 'https://example.com',
      });

      expect(route.path).toBe('/double-slash');

      const retrieved = await recordAt(env.ROUTES, testDomain, '/double-slash');
      expect(retrieved).not.toBeNull();
    });

    it('normalizes paths with trailing slashes when creating routes', async () => {
      const route = await createRoute(env.ROUTES, testDomain, {
        path: '/trailing-test/',
        type: 'redirect',
        target: 'https://example.com',
      });

      expect(route.path).toBe('/trailing-test');

      const retrieved = await recordAt(env.ROUTES, testDomain, '/trailing-test');
      expect(retrieved).not.toBeNull();
    });

    it('normalizes paths without leading slash when creating routes', async () => {
      const route = await createRoute(env.ROUTES, testDomain, {
        path: 'test-route',
        type: 'redirect',
        target: 'https://example.com',
      });

      expect(route.path).toBe('/test-route');

      const retrieved = await recordAt(env.ROUTES, testDomain, '/test-route');
      expect(retrieved).not.toBeNull();
    });

    it('normalizes mixed-case paths to lowercase when creating routes', async () => {
      const route = await createRoute(env.ROUTES, testDomain, {
        path: '/LinkedIn',
        type: 'redirect',
        target: 'https://linkedin.com/in/example',
      });

      expect(route.path).toBe('/linkedin');

      const retrieved = await recordAt(env.ROUTES, testDomain, '/linkedin');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.path).toBe('/linkedin');
    });

    it('retrieves lowercase route regardless of lookup case (via lookupRoute)', async () => {
      await createRoute(env.ROUTES, testDomain, {
        path: '/GitHub',
        type: 'redirect',
        target: 'https://github.com/example',
      });

      // lookupRoute normalizes the request path, so all case variants should hit the same route
      const lower = await served(env.ROUTES, testDomain, '/github');
      const upper = await served(env.ROUTES, testDomain, '/GITHUB');
      const mixed = await served(env.ROUTES, testDomain, '/GitHub');
      expect(lower).not.toBeNull();
      expect(upper).not.toBeNull();
      expect(mixed).not.toBeNull();
      expect(lower?.path).toBe('/github');
      expect(upper?.path).toBe('/github');
      expect(mixed?.path).toBe('/github');
    });
  });

  describe('path normalization on lookup', () => {
    it('retrieves route by exact path after normalized create', async () => {
      // Create route — createRoute normalizes the path on write
      await createRoute(env.ROUTES, testDomain, {
        path: '/encoded-test',
        type: 'redirect',
        target: 'https://example.com',
      });

      // Exact lookup works (getRoute does not apply normalization; the key must match exactly)
      const route = await recordAt(env.ROUTES, testDomain, '/encoded-test');
      expect(route).not.toBeNull();
      expect(route?.path).toBe('/encoded-test');
    });
  });

  describe('path normalization on update', () => {
    it('normalizes path when updating a route', async () => {
      // Create route
      await createRoute(env.ROUTES, testDomain, {
        path: '/test-route',
        type: 'redirect',
        target: 'https://example.com',
      });

      // Update using non-normalized path
      const updated = await updateRoute(env.ROUTES, testDomain, '/test-route/', {
        target: 'https://updated.com',
      });

      expect(updated).not.toBeNull();
      expect(updated?.target).toBe('https://updated.com');
      expect(updated?.path).toBe('/test-route');
    });
  });

  async function storedRecord(): Promise<Record<string, unknown> | null> {
    return env.ROUTES.get(routeKey(testDomain, '/test-route'), 'json');
  }

  describe('update keeps the stored type and target', () => {
    beforeEach(async () => {
      await createRoute(env.ROUTES, testDomain, {
        path: '/test-route',
        type: 'redirect',
        target: 'https://example.com/original',
      });
    });

    it('keeps both when the patch leaves them out', async () => {
      const updated = await updateRoute(env.ROUTES, testDomain, '/test-route', {
        cacheControl: 'no-store',
      });

      expect(updated?.type).toBe('redirect');
      expect(updated?.target).toBe('https://example.com/original');
      expect(updated?.cacheControl).toBe('no-store');
      expect(await storedRecord()).toMatchObject({
        type: 'redirect',
        target: 'https://example.com/original',
        cacheControl: 'no-store',
      });
    });

    it('keeps both when the patch carries them as undefined', async () => {
      // A parsed JSON body never produces this shape, but the patch type admits
      // it. A stored route without a type or target cannot be served.
      const updated = await updateRoute(env.ROUTES, testDomain, '/test-route', {
        type: undefined,
        target: undefined,
        cacheControl: 'no-store',
      });

      expect(updated?.type).toBe('redirect');
      expect(updated?.target).toBe('https://example.com/original');
      expect(await storedRecord()).toMatchObject({
        type: 'redirect',
        target: 'https://example.com/original',
        cacheControl: 'no-store',
      });
    });

    it('replaces both when the patch sets them', async () => {
      const updated = await updateRoute(env.ROUTES, testDomain, '/test-route', {
        type: 'proxy',
        target: 'https://example.net/replaced',
      });

      expect(updated?.type).toBe('proxy');
      expect(updated?.target).toBe('https://example.net/replaced');
      expect(await storedRecord()).toMatchObject({
        type: 'proxy',
        target: 'https://example.net/replaced',
      });
    });
  });

  describe('path normalization on delete', () => {
    it('deletes a route by exact path', async () => {
      // Create route — createRoute normalizes the path on write
      await createRoute(env.ROUTES, testDomain, {
        path: '/test-route',
        type: 'redirect',
        target: 'https://example.com',
      });

      // deleteRoute requires the exact normalized path (it does not call normalizePath internally)
      const deleted = await deleteRoute(env.ROUTES, testDomain, '/test-route');
      expect(deleted.status).toBe('ok');

      // Verify deletion
      const route = await recordAt(env.ROUTES, testDomain, '/test-route');
      expect(route).toBeNull();
    });
  });

  describe('seedRoutes with normalization', () => {
    it('normalizes paths when seeding routes', async () => {
      const routes = [
        {
          path: '/seed-test/',
          type: 'redirect' as const,
          target: 'https://example.com',
        },
      ];

      const result = await seedRoutes(env.ROUTES, testDomain, routes);
      expect(result.created).toBe(1);

      // Should be stored with normalized path
      const route = await recordAt(env.ROUTES, testDomain, '/seed-test');
      expect(route).not.toBeNull();
      expect(route?.path).toBe('/seed-test');
    });
  });

  describe('create/lookup consistency', () => {
    it('createRoute decodes URL-encoded paths so lookup uses the decoded form', async () => {
      // createRoute calls normalizePath which decodes URL-encoded characters
      const created = await createRoute(env.ROUTES, testDomain, {
        path: '/path%2Fwith%2Fslashes',
        type: 'redirect',
        target: 'https://example.com',
      });

      // The stored path is the decoded form
      expect(created.path).toBe('/path/with/slashes');

      // Retrievable with the decoded path (getRoute uses the key as-is, no decoding)
      const routeDecoded = await recordAt(env.ROUTES, testDomain, '/path/with/slashes');
      expect(routeDecoded).not.toBeNull();
      expect(routeDecoded?.path).toBe('/path/with/slashes');
    });
  });
});

describe('getAllRoutes', () => {
  const testDomain = 'allroutes.example.com';

  beforeEach(async () => {
    await clearRoutes(testDomain);
  });

  it('returns empty array when no routes exist', async () => {
    const routes = await getAllRoutes(env.ROUTES, testDomain);
    expect(routes).toEqual([]);
  });

  it('returns all routes for a domain', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/first',
      type: 'redirect',
      target: 'https://first.example.com',
    });
    await createRoute(env.ROUTES, testDomain, {
      path: '/second',
      type: 'redirect',
      target: 'https://second.example.com',
    });
    await createRoute(env.ROUTES, testDomain, {
      path: '/third',
      type: 'proxy',
      target: 'https://third.example.com',
    });

    const routes = await getAllRoutes(env.ROUTES, testDomain);
    expect(routes).toHaveLength(3);

    const paths = routes.map(r => r.path).toSorted();
    expect(paths).toEqual(['/first', '/second', '/third']);
  });

  it('does not return routes from other domains', async () => {
    const otherDomain = 'other-allroutes.example.com';
    await createRoute(env.ROUTES, testDomain, {
      path: '/mine',
      type: 'redirect',
      target: 'https://mine.example.com',
    });
    await createRoute(env.ROUTES, otherDomain, {
      path: '/theirs',
      type: 'redirect',
      target: 'https://theirs.example.com',
    });

    const routes = await getAllRoutes(env.ROUTES, testDomain);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/mine');

    // Clean up
    await clearRoutes(otherDomain);
  });
});

describe('getAllRoutesAllDomains', () => {
  // getAllRoutesAllDomains only returns routes for keys whose domain is in SUPPORTED_DOMAINS
  const domain1 = 'example.com';
  const domain2 = 'secondary.example.net';

  beforeEach(async () => {
    await clearRoutes(domain1);
    await clearRoutes(domain2);
  });

  it('returns routes from multiple domains with domain field', async () => {
    await createRoute(env.ROUTES, domain1, {
      path: '/route-a',
      type: 'redirect',
      target: 'https://a.example.com',
    });
    await createRoute(env.ROUTES, domain2, {
      path: '/route-b',
      type: 'proxy',
      target: 'https://b.example.com',
    });

    const routes = await getAllRoutesAllDomains(env.ROUTES);

    // Should include routes from both supported domains
    const routeA = routes.find(r => r.path === '/route-a');
    const routeB = routes.find(r => r.path === '/route-b');

    expect(routeA).toBeDefined();
    expect(routeA?.domain).toBe(domain1);
    expect(routeB).toBeDefined();
    expect(routeB?.domain).toBe(domain2);
  });
});

describe('migrateRoute', () => {
  const testDomain = 'migrate.example.com';

  beforeEach(async () => {
    await clearRoutes(testDomain);
  });

  it('migrates a route to a new path', async () => {
    const original = await createRoute(env.ROUTES, testDomain, {
      path: '/old-path',
      type: 'redirect',
      target: 'https://example.com',
    });

    const migrated = await migrateRoute(env.ROUTES, testDomain, '/old-path', '/new-path');

    expect(migrated).not.toBeNull();
    expect(migrated?.path).toBe('/new-path');
    expect(migrated?.target).toBe('https://example.com');
    expect(migrated?.createdAt).toBe(original.createdAt);
    expect(migrated?.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
  });

  it('deletes the old route after migration', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/old-path',
      type: 'redirect',
      target: 'https://example.com',
    });

    await migrateRoute(env.ROUTES, testDomain, '/old-path', '/new-path');

    const oldRoute = await recordAt(env.ROUTES, testDomain, '/old-path');
    expect(oldRoute).toBeNull();
  });

  it('returns null when old path does not exist', async () => {
    const result = await migrateRoute(env.ROUTES, testDomain, '/nonexistent', '/new-path');
    expect(result).toBeNull();
  });

  it('throws when old path and new path are the same', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/same-path',
      type: 'redirect',
      target: 'https://example.com',
    });

    await expect(migrateRoute(env.ROUTES, testDomain, '/same-path', '/same-path')).rejects.toThrow(
      'Old path and new path cannot be the same',
    );
  });

  it('throws when new path already has a route', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/source',
      type: 'redirect',
      target: 'https://source.example.com',
    });
    await createRoute(env.ROUTES, testDomain, {
      path: '/destination',
      type: 'redirect',
      target: 'https://destination.example.com',
    });

    await expect(migrateRoute(env.ROUTES, testDomain, '/source', '/destination')).rejects.toThrow(
      'Route already exists at path: /destination',
    );
  });

  it('preserves all route configuration fields', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/old',
      type: 'redirect',
      target: 'https://example.com',
      statusCode: 301,
      preserveQuery: false,
      preservePath: true,
      enabled: true,
    });

    const migrated = await migrateRoute(env.ROUTES, testDomain, '/old', '/new');

    expect(migrated).not.toBeNull();
    expect(migrated?.type).toBe('redirect');
    expect(migrated?.target).toBe('https://example.com');
    expect(migrated?.statusCode).toBe(301);
    expect(migrated?.preserveQuery).toBe(false);
    expect(migrated?.preservePath).toBe(true);
    expect(migrated?.enabled).toBe(true);
  });

  it('normalizes both old and new paths', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/original',
      type: 'redirect',
      target: 'https://example.com',
    });

    const migrated = await migrateRoute(env.ROUTES, testDomain, '/original/', '/moved/');
    expect(migrated).not.toBeNull();
    expect(migrated?.path).toBe('/moved');
  });
});

describe('parseRouteKey (re-export)', () => {
  it('is exported from routes module', () => {
    expectTypeOf(parseRouteKey).toBeFunction();
  });

  it('parses a valid key', () => {
    const [domain, path] = parseRouteKey('links.example.com:/github');
    expect(domain).toBe('links.example.com');
    expect(path).toBe('/github');
  });
});

/**
 * ONE key per mutation.
 *
 * `normalizePath()` strips `?` and `#` BEFORE percent-decoding, so it is not
 * idempotent: `/p%3Fx` → `/p?x` → `/p`. Every mutating function normalises
 * once and must then read through a helper that does NOT normalise again —
 * otherwise the READ resolves a different key from the WRITE, and an update can
 * publish a second, unexamined copy of a route.
 */
describe('KV single-key discipline', () => {
  const singleKeyDomain = 'single-key.example.com';

  beforeEach(async () => {
    await clearRoutes(singleKeyDomain);
  });

  /** Plant a record under a key a second normalisation pass would not resolve. */
  async function plantNonIdempotentKey(): Promise<string> {
    const storedPath = '/p?x';
    await env.ROUTES.put(
      routeKey(singleKeyDomain, storedPath),
      JSON.stringify({
        path: storedPath,
        type: 'redirect',
        target: 'https://app.example/original',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    return storedPath;
  }

  it('updates the record it read, never a second copy', async () => {
    const storedPath = await plantNonIdempotentKey();

    // `/p%3Fx` normalises ONCE to the stored `/p?x`.
    const updated = await updateRoute(env.ROUTES, singleKeyDomain, '/p%3Fx', {
      target: 'https://app.example/updated',
    });

    expect(updated?.target).toBe('https://app.example/updated');
    // Exactly one record exists for this domain — no phantom copy at `/p`.
    const keys = await env.ROUTES.list({ prefix: `${singleKeyDomain}:` });
    expect(keys.keys.map(k => k.name)).toEqual([routeKey(singleKeyDomain, storedPath)]);
  });

  it('deletes the record it read', async () => {
    const storedPath = await plantNonIdempotentKey();

    expect((await deleteRoute(env.ROUTES, singleKeyDomain, '/p%3Fx')).status).toBe('ok');
    expect(await env.ROUTES.get(routeKey(singleKeyDomain, storedPath))).toBeNull();
  });

  it('migrates the record it read', async () => {
    await plantNonIdempotentKey();

    const migrated = await migrateRoute(env.ROUTES, singleKeyDomain, '/p%3Fx', '/moved');

    expect(migrated?.path).toBe('/moved');
    const keys = await env.ROUTES.list({ prefix: `${singleKeyDomain}:` });
    expect(keys.keys.map(k => k.name)).toEqual([routeKey(singleKeyDomain, '/moved')]);
  });

  it('normalises a delete exactly once, like create and update', async () => {
    // Create normalises (lowercase, trailing slash); delete must resolve the
    // same key from the same raw input.
    await createRoute(env.ROUTES, singleKeyDomain, {
      path: '/Case-Test/',
      type: 'redirect',
      target: 'https://app.example/ok',
    });

    expect(await recordAt(env.ROUTES, singleKeyDomain, '/case-test')).not.toBeNull();
    expect((await deleteRoute(env.ROUTES, singleKeyDomain, '/Case-Test/')).status).toBe('ok');
    expect(await recordAt(env.ROUTES, singleKeyDomain, '/case-test')).toBeNull();
  });
});
