import { normalizeRoutePath } from '@bifrost/shared';
import type { KVRouteConfig } from '../types';
import { fitsKvKey, routeKey } from './schema';

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
  // One implementation, shared with the write schemas' key limit
  return normalizeRoutePath(path);
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
  requestPath: string,
): Promise<KVRouteConfig | null> {
  const path = normalizePath(requestPath);

  // 1. Try exact match first
  // KV refuses a key over its 512-byte limit even on read (a 500 for any
  // visitor with a long enough path); no route can be stored under one
  const exactKey = routeKey(domain, path);
  const exact = fitsKvKey(exactKey) ? await kv.get<KVRouteConfig>(exactKey, 'json') : null;
  if (exact && exact.enabled !== false) {
    return exact;
  }

  // 2. Try wildcard matches (longest prefix wins)
  const wildcardCandidates = getWildcardCandidates(path);

  // Candidate precedence is positional, not temporal. Load all fallbacks in
  // parallel, then inspect the results from most-specific to least-specific.
  // A deep root-wildcard hit or miss therefore pays one wildcard KV round trip
  // instead of one round trip per path segment.
  const wildcardRoutes = await Promise.all(
    wildcardCandidates.map(wildcardPath => {
      const key = routeKey(domain, wildcardPath);
      return fitsKvKey(key) ? kv.get<KVRouteConfig>(key, 'json') : null;
    }),
  );

  for (const wildcard of wildcardRoutes) {
    if (wildcard && wildcard.enabled !== false) {
      return wildcard;
    }
  }

  // No match found
  return null;
}

/**
 * The remainder of the RAW request path (`URL.pathname`, still
 * percent-encoded) after a wildcard route's base, for the handlers that append
 * it to a target: the redirect's `preservePath`, the proxy and the own-host
 * preview (v1.37.2). Example: `/blog/my-post` against `/blog/*` gives
 * `/my-post`.
 *
 * The raw path is walked segment by segment against the route's base segments
 * (empty segments skipped, as normalizePath collapses them): each raw base
 * segment is decoded once and must equal the base segment as the lookup
 * normalised it (case-insensitive). A raw base segment that decodes to a `/` or
 * `\` (`/docs%2Fv1/page` against `/docs/v1/*`), or a malformed escape in one,
 * aligns with nothing, so the answer is null (the caller answers 404). The rest
 * of the raw path, as written, is the remainder; `/` when nothing follows the
 * base. Slicing the raw path by the length of the normalised base cut into the
 * remainder whenever the two differed (`//blog/post`, `/%62log/post`).
 */
export function rawWildcardRemainder(rawPath: string, routePath: string): string | null {
  if (!routePath.endsWith('/*')) return null;
  const baseSegments = routePath.slice(0, -2).split('/').filter(Boolean);
  const parts = rawPath.split('/');
  let cut = 1;
  let matched = 0;
  while (matched < baseSegments.length) {
    if (cut >= parts.length) return null;
    const part = parts[cut] ?? '';
    cut += 1;
    if (part === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (decoded.includes('/') || decoded.includes('\\')) return null;
    if (decoded.toLowerCase() !== baseSegments[matched]) return null;
    matched += 1;
  }
  return `/${parts.slice(cut).join('/')}`;
}
