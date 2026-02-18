import { env, SELF } from 'cloudflare:test';
import type { KVRouteConfig } from '../src/types';
import { routeKey, domainPrefix } from '../src/kv/schema';

/**
 * Default test domain
 */
export const TEST_DOMAIN = 'henrychong.com';

/**
 * Seed a single route into KV for testing
 * @param route - Route configuration
 * @param domain - Domain for the route (defaults to TEST_DOMAIN)
 */
export async function seedRoute(
  route: KVRouteConfig,
  domain = TEST_DOMAIN,
): Promise<void> {
  const kv = env.ROUTES;
  // Store the route with domain prefix (e.g., "henrychong.com:/github")
  await kv.put(routeKey(domain, route.path), JSON.stringify(route));
}

/**
 * Seed multiple routes into KV for testing
 * @param routes - Array of route configurations
 * @param domain - Domain for the routes (defaults to TEST_DOMAIN)
 */
export async function seedRoutes(
  routes: KVRouteConfig[],
  domain = TEST_DOMAIN,
): Promise<void> {
  for (const route of routes) {
    await seedRoute(route, domain);
  }
}

/**
 * Clear all routes from KV for a specific domain
 * @param domain - Domain to clear routes for (defaults to TEST_DOMAIN)
 */
export async function clearRoutes(domain = TEST_DOMAIN): Promise<void> {
  const kv = env.ROUTES;
  const prefix = domainPrefix(domain);

  // List and delete all keys with domain prefix
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix, cursor });
    for (const key of result.keys) {
      await kv.delete(key.name);
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

/**
 * Clear all routes from KV for all test domains
 */
export async function clearAllRoutes(): Promise<void> {
  const testDomains = [
    'henrychong.com',
    'link.henrychong.com',
    'vanessahung.net',
  ];
  for (const domain of testDomains) {
    await clearRoutes(domain);
  }
}

/**
 * Make a request to the worker
 */
export async function makeRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, options);
}

/**
 * Make an admin API request
 */
export async function makeAdminRequest(
  path: string,
  options: RequestInit = {},
  apiKey = 'test-api-key-12345',
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('X-Admin-Key', apiKey);

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeRequest(`/api${path}`, {
    ...options,
    headers,
  });
}

/**
 * Create an R2 object for testing
 */
export async function seedR2Object(
  key: string,
  content: string | ArrayBuffer,
  contentType = 'application/octet-stream',
): Promise<void> {
  const bucket = env.FILES_BUCKET;
  await bucket.put(key, content, {
    httpMetadata: { contentType },
  });
}

/**
 * Clear all objects from R2 bucket
 */
export async function clearR2(): Promise<void> {
  const bucket = env.FILES_BUCKET;
  const objects = await bucket.list();

  for (const obj of objects.objects) {
    await bucket.delete(obj.key);
  }
}

/**
 * Parse JSON response body
 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
