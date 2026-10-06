import { normalizeRoutePath } from '@bifrost/shared';
import type { KVRouteConfig } from '../types';
import { routeKey } from './schema';
import { readRouteState } from './stored-route';

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
 * The outcome of a route lookup (v1.38.0): a route to serve, no route
 * (`missing`: the caller may fall back to a service binding), or `invalid`:
 * a stored record on the way that cannot be read, which the caller answers
 * with a 404 and nothing else, never a broader wildcard and never a fallback.
 */
export type RouteLookup =
  | { status: 'ok'; route: KVRouteConfig }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Look up the route a request path is served by
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
 * A disabled route is skipped. Each record is read as text and validated
 * (readRouteState; a key over KV's 512-byte limit reads as absent, since no
 * route can be stored there). An invalid record met on the way STOPS the
 * lookup as `invalid` rather than falling through to a broader wildcard.
 */
export async function lookupRoute(
  kv: KVNamespace,
  domain: string,
  requestPath: string,
): Promise<RouteLookup> {
  const path = normalizePath(requestPath);

  // 1. Try exact match first
  const exact = await readRouteState(kv, routeKey(domain, path));
  if (exact.status === 'invalid') return { status: 'invalid' };
  if (exact.status === 'ok' && exact.value.enabled !== false) {
    return { status: 'ok', route: exact.value };
  }

  // 2. Try wildcard matches (longest prefix wins)
  const wildcardCandidates = getWildcardCandidates(path);

  // Candidate precedence is positional, not temporal. Load all fallbacks in
  // parallel, then inspect the results from most-specific to least-specific.
  // A deep root-wildcard hit or miss therefore pays one wildcard KV round trip
  // instead of one round trip per path segment.
  const wildcardRoutes = await Promise.all(
    wildcardCandidates.map(wildcardPath => readRouteState(kv, routeKey(domain, wildcardPath))),
  );

  for (const wildcard of wildcardRoutes) {
    // An invalid wildcard stops too, never yielding to a broader one
    if (wildcard.status === 'invalid') return { status: 'invalid' };
    if (wildcard.status === 'ok' && wildcard.value.enabled !== false) {
      return { status: 'ok', route: wildcard.value };
    }
  }

  // No match found
  return { status: 'missing' };
}

/**
 * The route a request path is served by, or null when there is none or an
 * invalid record stops the lookup (see {@link lookupRoute}, which tells the
 * two apart: the router answers an invalid record with a 404 and never falls
 * back to a service binding).
 */
export async function matchRoute(
  kv: KVNamespace,
  domain: string,
  requestPath: string,
): Promise<KVRouteConfig | null> {
  const lookup = await lookupRoute(kv, domain, requestPath);
  return lookup.status === 'ok' ? lookup.route : null;
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
