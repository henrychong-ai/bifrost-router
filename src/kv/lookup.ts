import type { KVRouteConfig } from '../types';
import { routeKey } from './schema';

/**
 * Normalize a path for consistent lookup
 *
 * Operations performed:
 * - Decodes URL-encoded characters
 * - Removes query string and hash
 * - Collapses multiple slashes
 * - Removes trailing slashes (except for root)
 * - Ensures path starts with /
 */
export function normalizePath(path: string): string {
  // Remove query string and hash
  let normalized = path.split('?')[0].split('#')[0];

  // URL decode the path (handle %20, etc.)
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep original if decoding fails (malformed encoding)
  }

  // Collapse multiple consecutive slashes to single slash
  normalized = normalized.replace(/\/+/g, '/');

  // Ensure path starts with /
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  // Remove trailing slash (except for root)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Generate wildcard candidates for a path
 * Example: "/blog/post/123" → ["/blog/post/*", "/blog/*", "/*"]
 */
export function getWildcardCandidates(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const candidates: string[] = [];

  // Build candidates from most specific to least specific
  for (let i = segments.length - 1; i >= 0; i--) {
    const prefixPart = segments.slice(0, i).join('/');
    candidates.push(prefixPart ? `/${prefixPart}/*` : '/*');
  }

  return candidates;
}

/**
 * Match a request path to a route in KV
 *
 * @param kv - The unified KV namespace
 * @param domain - The domain to look up routes for
 * @param requestPath - The request path to match
 *
 * Matching priority:
 * 1. Exact match
 * 2. Longest wildcard prefix match
 * 3. Root wildcard (/*) if exists
 *
 * Returns null if no match found
 */
export async function matchRoute(
  kv: KVNamespace,
  domain: string,
  requestPath: string
): Promise<KVRouteConfig | null> {
  const path = normalizePath(requestPath);

  // 1. Try exact match first
  const exactKey = routeKey(domain, path);
  const exact = await kv.get<KVRouteConfig>(exactKey, 'json');
  if (exact && exact.enabled !== false) {
    return exact;
  }

  // 2. Try wildcard matches (longest prefix wins)
  const wildcardCandidates = getWildcardCandidates(path);

  for (const wildcardPath of wildcardCandidates) {
    const wildcardKey = routeKey(domain, wildcardPath);
    const wildcard = await kv.get<KVRouteConfig>(wildcardKey, 'json');
    if (wildcard && wildcard.enabled !== false) {
      return wildcard;
    }
  }

  // No match found
  return null;
}

/**
 * Extract the remaining path after a wildcard match
 * Example: path="/blog/my-post", routePath="/blog/*" → "/my-post"
 */
export function getWildcardRemainder(path: string, routePath: string): string {
  if (!routePath.endsWith('/*')) {
    return '';
  }

  const basePath = routePath.slice(0, -2); // Remove "/*"
  const remainder = path.slice(basePath.length);

  return remainder || '/';
}
