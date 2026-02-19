import { describe, it, expect, expectTypeOf, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createRoute,
  getRoute,
  getRouteSafe,
  getAllRoutes,
  getAllRoutesAllDomains,
  getMetadata,
  migrateRoute,
  parseRouteKey,
  updateRoute,
  deleteRoute,
  seedRoutes,
} from '../../src/kv/routes';
import { SCHEMA_VERSION } from '../../src/kv/schema';
import { SUPPORTED_DOMAINS } from '../../src/types';
import { clearRoutes } from '../helpers';

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
      const retrieved = await getRoute(env.ROUTES, testDomain, '/hello world');
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

      const retrieved = await getRoute(env.ROUTES, testDomain, '/double-slash');
      expect(retrieved).not.toBeNull();
    });

    it('normalizes paths with trailing slashes when creating routes', async () => {
      const route = await createRoute(env.ROUTES, testDomain, {
        path: '/trailing-test/',
        type: 'redirect',
        target: 'https://example.com',
      });

      expect(route.path).toBe('/trailing-test');

      const retrieved = await getRoute(env.ROUTES, testDomain, '/trailing-test');
      expect(retrieved).not.toBeNull();
    });

    it('normalizes paths without leading slash when creating routes', async () => {
      const route = await createRoute(env.ROUTES, testDomain, {
        path: 'test-route',
        type: 'redirect',
        target: 'https://example.com',
      });

      expect(route.path).toBe('/test-route');

      const retrieved = await getRoute(env.ROUTES, testDomain, '/test-route');
      expect(retrieved).not.toBeNull();
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
      const route = await getRoute(env.ROUTES, testDomain, '/encoded-test');
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
      expect(deleted).toBe(true);

      // Verify deletion
      const route = await getRoute(env.ROUTES, testDomain, '/test-route');
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
      const route = await getRoute(env.ROUTES, testDomain, '/seed-test');
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
      const routeDecoded = await getRoute(env.ROUTES, testDomain, '/path/with/slashes');
      expect(routeDecoded).not.toBeNull();
      expect(routeDecoded?.path).toBe('/path/with/slashes');
    });
  });
});

describe('getRouteSafe', () => {
  const testDomain = 'safe.example.com';

  beforeEach(async () => {
    await clearRoutes(testDomain);
  });

  it('returns success with route data when found', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/existing',
      type: 'redirect',
      target: 'https://example.com',
    });

    const result = await getRouteSafe(env.ROUTES, testDomain, '/existing');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toBeNull();
      expect(result.data?.path).toBe('/existing');
    }
  });

  it('returns success with null when route not found', async () => {
    const result = await getRouteSafe(env.ROUTES, testDomain, '/nonexistent');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
    }
  });

  it('retrieves route by exact path', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/normalized',
      type: 'redirect',
      target: 'https://example.com',
    });

    // getRouteSafe uses the path key as-is; exact match required
    const result = await getRouteSafe(env.ROUTES, testDomain, '/normalized');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toBeNull();
      expect(result.data?.path).toBe('/normalized');
    }
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

    const paths = routes.map(r => r.path).sort();
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
  // Use dynamic references so tests work regardless of configured domains
  const domain1 = SUPPORTED_DOMAINS[0];
  const domain2 = SUPPORTED_DOMAINS[3];

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

describe('getMetadata', () => {
  const testDomain = 'metadata.example.com';

  beforeEach(async () => {
    await clearRoutes(testDomain);
  });

  it('returns metadata with zero count when no routes exist', async () => {
    const metadata = await getMetadata(env.ROUTES, testDomain);
    expect(metadata.version).toBe(SCHEMA_VERSION);
    expect(metadata.count).toBe(0);
    expect(metadata.updatedAt).toBeGreaterThan(0);
  });

  it('returns correct route count', async () => {
    await createRoute(env.ROUTES, testDomain, {
      path: '/one',
      type: 'redirect',
      target: 'https://one.example.com',
    });
    await createRoute(env.ROUTES, testDomain, {
      path: '/two',
      type: 'redirect',
      target: 'https://two.example.com',
    });

    const metadata = await getMetadata(env.ROUTES, testDomain);
    expect(metadata.count).toBe(2);
    expect(metadata.version).toBe(SCHEMA_VERSION);
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

    const oldRoute = await getRoute(env.ROUTES, testDomain, '/old-path');
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
    const [domain, path] = parseRouteKey('link.example.com:/github');
    expect(domain).toBe('link.example.com');
    expect(path).toBe('/github');
  });
});
