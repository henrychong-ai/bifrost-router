import { env, SELF } from 'cloudflare:test';
import type { KVRouteConfig } from '../src/types';
import { routeKey, domainPrefix } from '../src/kv/schema';

/**
 * Default test domain
 */
export const TEST_DOMAIN = 'example.com';

/**
 * Seed a single route into KV for testing
 * @param route - Route configuration
 * @param domain - Domain for the route (defaults to TEST_DOMAIN)
 */
export async function seedRoute(route: KVRouteConfig, domain = TEST_DOMAIN): Promise<void> {
  const kv = env.ROUTES;
  // Store the route with domain prefix (e.g., "example.com:/github")
  await kv.put(routeKey(domain, route.path), JSON.stringify(route));
}

/**
 * Seed multiple routes into KV for testing
 * @param routes - Array of route configurations
 * @param domain - Domain for the routes (defaults to TEST_DOMAIN)
 */
export async function seedRoutes(routes: KVRouteConfig[], domain = TEST_DOMAIN): Promise<void> {
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
  const testDomains = ['example.com', 'links.example.com', 'secondary.example.net'];
  for (const domain of testDomains) {
    await clearRoutes(domain);
  }
}

/**
 * Make a request to the worker
 */
export async function makeRequest(path: string, options: RequestInit = {}): Promise<Response> {
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
 * An ExecutionContext whose `waitUntil` work can be AWAITED.
 *
 * Deliberately NOT named `createExecutionContext`: `cloudflare:test` exports a
 * function of that name with a different contract (it pairs with
 * `waitOnExecutionContext`). This one is for suites that drive
 * `worker.fetch()` directly and must settle the recorder's background write
 * before reading the row back.
 */
export function createSettlingExecutionContext(): {
  ctx: ExecutionContext;
  settled: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    settled: async () => {
      await Promise.allSettled(pending);
    },
  };
}

/**
 * Serve `path` through the REAL worker on `domain` and settle the recorder's
 * `waitUntil`, so an analytics row is readable immediately afterwards. The body
 * is drained first: a streamed R2 or proxy read must complete before the
 * assertions.
 */
export async function serveThroughWorker(
  path: string,
  headers: HeadersInit = {},
  domain = TEST_DOMAIN,
): Promise<Response> {
  // Imported lazily: a STATIC import would pull the whole Worker — including
  // the generated changelog module — into every suite that imports these
  // helpers, most of which never serve a request.
  const { default: worker } = await import('../src/index');
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await worker.fetch(
    new Request(`https://${domain}${path}`, { headers }),
    env,
    ctx,
  );
  await response.clone().arrayBuffer();
  await settled();
  return response;
}

/**
 * The legacy analytics DDL the recorder suites need. The Workers pool gives
 * each test FILE its own D1, so every suite that reads a legacy table creates
 * it first.
 */
export async function createFileDownloadsTable(): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS file_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      content_type TEXT,
      file_size INTEGER,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      cache_status TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `).run();
}

export async function createLinkClicksTable(): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS link_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      slug TEXT NOT NULL,
      target_url TEXT NOT NULL,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      http_protocol TEXT,
      timezone TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `).run();
}

export async function createProxyRequestsTable(): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      target_url TEXT NOT NULL,
      response_status INTEGER,
      content_type TEXT,
      content_length INTEGER,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `).run();
}

export async function createPageViewsTable(): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `).run();
}

/** The audit-log table, for suites that assert on what a mutation recorded. */
export async function createAuditLogsTable(): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_login TEXT,
      actor_name TEXT,
      path TEXT,
      details TEXT,
      ip_address TEXT,
      source TEXT NOT NULL DEFAULT 'bifrost',
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `).run();
}

/** All four legacy per-feature recorder tables. */
export async function createLegacyRecorderTables(): Promise<void> {
  await createLinkClicksTable();
  await createFileDownloadsTable();
  await createProxyRequestsTable();
  await createPageViewsTable();
}

/**
 * Parse JSON response body
 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
