import type { KVRouteConfig, RoutesMetadata, SupportedDomain } from '../types';
import { SUPPORTED_DOMAINS } from '../types';
import { routeKey, domainPrefix, parseRouteKey, SCHEMA_VERSION, type CreateRouteInput } from './schema';
import {
  KVReadError,
  KVWriteError,
  KVDeleteError,
  withKVErrorHandling,
  type KVResult,
} from '../utils/kv-errors';
import { normalizePath } from './lookup';

/**
 * Get a single route by domain and path
 * Returns null if not found, throws KVReadError on failure
 */
export async function getRoute(
  kv: KVNamespace,
  domain: string,
  path: string
): Promise<KVRouteConfig | null> {
  const key = routeKey(domain, path);
  try {
    return await kv.get<KVRouteConfig>(key, 'json');
  } catch (error) {
    throw new KVReadError(
      key,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Get a single route by domain and path with result type
 * Safer alternative that doesn't throw
 */
export async function getRouteSafe(
  kv: KVNamespace,
  domain: string,
  path: string
): Promise<KVResult<KVRouteConfig | null>> {
  const key = routeKey(domain, path);
  return withKVErrorHandling(
    () => kv.get<KVRouteConfig>(key, 'json'),
    (cause) => new KVReadError(key, cause)
  );
}

/**
 * Get all routes for a domain from KV
 * Uses prefix-based listing for unified KV namespace
 * Throws KVReadError on failure
 */
export async function getAllRoutes(
  kv: KVNamespace,
  domain: string
): Promise<KVRouteConfig[]> {
  try {
    const prefix = domainPrefix(domain);
    const routes: KVRouteConfig[] = [];
    let cursor: string | undefined;

    // List all keys with domain prefix
    do {
      const result = await kv.list({ prefix, cursor });

      // Fetch route values for each key
      const routePromises = result.keys.map(async (key) => {
        const route = await kv.get<KVRouteConfig>(key.name, 'json');
        return route;
      });

      const routeResults = await Promise.all(routePromises);
      routes.push(...routeResults.filter((r): r is KVRouteConfig => r !== null));

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return routes;
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError(
      `list:${domain}`,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Route configuration with domain field (for all-domains queries)
 */
export type KVRouteConfigWithDomain = KVRouteConfig & { domain: SupportedDomain };

/**
 * Get all routes for ALL domains from KV
 * Lists all keys (no prefix) and parses domain from each key
 * Returns routes with domain field included
 * Throws KVReadError on failure
 */
export async function getAllRoutesAllDomains(
  kv: KVNamespace
): Promise<KVRouteConfigWithDomain[]> {
  try {
    const routes: KVRouteConfigWithDomain[] = [];
    let cursor: string | undefined;

    // List all keys (no prefix = all domains)
    do {
      const result = await kv.list({ cursor });

      // Fetch route values and parse domain from key
      const routePromises = result.keys.map(async (key) => {
        try {
          // Parse domain from key (format: "domain:/path")
          const [domain] = parseRouteKey(key.name);

          // Skip if not a supported domain (e.g., metadata keys)
          if (!SUPPORTED_DOMAINS.includes(domain as SupportedDomain)) {
            return null;
          }

          const route = await kv.get<KVRouteConfig>(key.name, 'json');
          if (!route) return null;

          return { ...route, domain: domain as SupportedDomain };
        } catch {
          // Skip invalid keys (e.g., keys without colon separator)
          return null;
        }
      });

      const routeResults = await Promise.all(routePromises);
      routes.push(...routeResults.filter((r): r is KVRouteConfigWithDomain => r !== null));

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return routes;
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError(
      'list:all',
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Create a new route
 * Throws KVWriteError on failure
 */
export async function createRoute(
  kv: KVNamespace,
  domain: string,
  input: CreateRouteInput
): Promise<KVRouteConfig> {
  const now = Date.now();
  const normalizedPath = normalizePath(input.path);
  const key = routeKey(domain, normalizedPath);

  const route: KVRouteConfig = {
    ...input,
    path: normalizedPath,
    preserveQuery: input.preserveQuery ?? true,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await kv.put(key, JSON.stringify(route));
    return route;
  } catch (error) {
    throw new KVWriteError(
      key,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Update an existing route
 * Returns null if not found, throws KVWriteError on failure
 */
export async function updateRoute(
  kv: KVNamespace,
  domain: string,
  path: string,
  updates: Partial<CreateRouteInput>
): Promise<KVRouteConfig | null> {
  const normalizedPath = normalizePath(path);
  const existing = await getRoute(kv, domain, normalizedPath);
  if (!existing) return null;

  const key = routeKey(domain, normalizedPath);
  const updated: KVRouteConfig = {
    ...existing,
    ...updates,
    path: normalizedPath, // Path cannot be changed
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  try {
    await kv.put(key, JSON.stringify(updated));
    return updated;
  } catch (error) {
    throw new KVWriteError(
      key,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Delete a route
 * Returns false if not found, throws KVDeleteError on failure
 */
export async function deleteRoute(
  kv: KVNamespace,
  domain: string,
  path: string
): Promise<boolean> {
  const existing = await getRoute(kv, domain, path);
  if (!existing) return false;

  const key = routeKey(domain, path);
  try {
    await kv.delete(key);
    return true;
  } catch (error) {
    throw new KVDeleteError(
      key,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Seed routes from an array (useful for migration)
 */
export async function seedRoutes(
  kv: KVNamespace,
  domain: string,
  routes: CreateRouteInput[]
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const route of routes) {
    const existing = await getRoute(kv, domain, route.path);
    if (existing) {
      skipped++;
      continue;
    }
    await createRoute(kv, domain, route);
    created++;
  }

  return { created, skipped };
}

/**
 * Get metadata for routes in a domain
 * Returns computed metadata based on route count
 */
export async function getMetadata(
  kv: KVNamespace,
  domain: string
): Promise<RoutesMetadata> {
  const routes = await getAllRoutes(kv, domain);
  return {
    version: SCHEMA_VERSION,
    updatedAt: Date.now(),
    count: routes.length,
  };
}

/**
 * Migrate a route from one path to another
 * Preserves createdAt timestamp for audit trail continuity
 * Returns the migrated route config, or null if oldPath not found
 * Throws error if newPath already exists or paths are the same
 */
export async function migrateRoute(
  kv: KVNamespace,
  domain: string,
  oldPath: string,
  newPath: string
): Promise<KVRouteConfig | null> {
  const normalizedOldPath = normalizePath(oldPath);
  const normalizedNewPath = normalizePath(newPath);

  // Validate paths are different
  if (normalizedOldPath === normalizedNewPath) {
    throw new Error('Old path and new path cannot be the same');
  }

  // Get existing route at oldPath
  const existing = await getRoute(kv, domain, normalizedOldPath);
  if (!existing) {
    return null;
  }

  // Check if newPath already exists
  const existingAtNew = await getRoute(kv, domain, normalizedNewPath);
  if (existingAtNew) {
    throw new Error(`Route already exists at path: ${normalizedNewPath}`);
  }

  const oldKey = routeKey(domain, normalizedOldPath);
  const newKey = routeKey(domain, normalizedNewPath);

  // Create migrated route with preserved createdAt
  const migratedRoute: KVRouteConfig = {
    ...existing,
    path: normalizedNewPath,
    createdAt: existing.createdAt, // Preserve original
    updatedAt: Date.now(),
  };

  try {
    // Write to new key first
    await kv.put(newKey, JSON.stringify(migratedRoute));
    // Delete old key
    await kv.delete(oldKey);
    return migratedRoute;
  } catch (error) {
    // Attempt rollback
    try {
      await kv.delete(newKey);
    } catch {
      /* ignore rollback errors */
    }
    throw new KVWriteError(
      `migrate:${oldKey}->${newKey}`,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

// Re-export parseRouteKey for use by migration scripts
export { parseRouteKey };
