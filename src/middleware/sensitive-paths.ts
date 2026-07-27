import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

/**
 * Path prefixes that should never resolve to a real Worker response.
 *
 * Bifrost has no filesystem and serves no source files. KV-defined routes
 * never start with these tokens. If a Workers Static Assets fallback or a
 * future SPA shell is ever wired into this Worker, an unmatched request to
 * `/wrangler.toml` would otherwise return the SPA `index.html` with HTTP 200
 * (cosmetic info-disclosure: the file isn't actually leaked, but a scanner
 * sees 200 and flags it). Returning a clean 404 here is cheap and keeps the
 * scanner-noise floor low.
 *
 * Conservative scope: only build-system / source-tree paths that no operator
 * would ever set up as a redirect. User-facing names like `/docs`, `/admin`,
 * `/backup`, `/swagger`, `/openapi.json` are deliberately *not* denied —
 * those are plausible KV redirect short-links and must remain available.
 */
// All entries lower-cased to match against `path.toLowerCase()` in the
// middleware. Source-form names like `Dockerfile` and `.DS_Store` are
// stored lower-cased (`/dockerfile`, `/.ds_store`) — the comparison is
// case-insensitive on the request side, mirroring the recommended WAF
// Custom Rules' `lower(...)` pattern.
const DENIED_EXACT_PATHS = new Set<string>([
  '/wrangler.toml',
  '/package.json',
  '/pnpm-lock.yaml',
  '/package-lock.json',
  '/yarn.lock',
  '/.dockerignore',
  '/.npmrc',
  '/.nvmrc',
  '/.prettierrc',
  '/.eslintrc',
  '/.eslintrc.json',
  '/biome.json',
  '/oxlint.json',
  '/tsconfig.json',
  '/dockerfile',
  '/docker-compose.yml',
  '/docker-compose.yaml',
  '/.ds_store',
]);

const DENIED_PREFIXES: readonly string[] = [
  '/src/',
  '/test/',
  '/tests/',
  '/node_modules/',
  '/.git/',
  '/.svn/',
  '/.aws/',
  '/.ssh/',
  '/_next/',
];

/**
 * Returns 404 for paths that should never resolve to a Worker handler.
 *
 * Mounted before the KV-lookup catch-all in `src/index.ts`. The admin API
 * (`/api/*`) and system routes (`/health`, `/.well-known/*`) are matched by
 * Hono first and bypass this middleware naturally.
 *
 * Path comparison is case-insensitive — scanners commonly probe both
 * `/wrangler.toml` and `/WRANGLER.TOML`. Normalising both sides matches the
 * `lower(...)` pattern recommended for the companion WAF Custom Rules
 * (see docs/cloudflare-waf.md).
 */
/**
 * Path-traversal sequences in a raw query string — the literal form plus the
 * URL-encodings scanners commonly use. Matching is done on the lower-cased raw
 * query AND best-effort URL-decode passes, so `?file=../../etc`,
 * `?file=..%2f..%2fetc`, and `%2e%2e%2f…` are all caught. Raw-substring matching
 * means a malformed `%` sequence can never throw.
 */
const QUERY_TRAVERSAL_TOKENS: readonly string[] = [
  '../',
  '..\\',
  '..%2f',
  '..%5c',
  '%2e%2e%2f',
  '%2e%2e%5c',
  '%2e%2e/',
  '%2e%2e\\',
];

function queryHasTraversal(rawSearch: string): boolean {
  let current = rawSearch.toLowerCase();
  // Check the raw query, then up to two further URL-decode passes, so single-,
  // double-, and triple-encoded traversal (`%2e%2e%2f`, `%252e%252e%252f`, …) are
  // all caught. Stop on a malformed `%` (decodeURIComponent throws) or once
  // decoding no longer changes the string.
  for (let pass = 0; pass < 3; pass++) {
    if (QUERY_TRAVERSAL_TOKENS.some(t => current.includes(t))) {
      return true;
    }
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) {
      break;
    }
    current = next;
  }
  return false;
}

export function denySensitivePaths() {
  return async function denySensitivePathsMiddleware(c: Context<AppEnv>, next: Next) {
    const path = c.req.path.toLowerCase();

    if (DENIED_EXACT_PATHS.has(path)) {
      return c.json({ error: 'Not Found', path: c.req.path }, 404);
    }

    for (const prefix of DENIED_PREFIXES) {
      if (path.startsWith(prefix)) {
        return c.json({ error: 'Not Found', path: c.req.path }, 404);
      }
    }

    // Query-string path-traversal guard — the query-string analog of the path
    // denylist above. Closes the query-only LFI class: a query-only LFI probe such as
    // `/?file=../../../etc/passwd` otherwise reaches the dashboard root. SCOPED
    // TO THE ADMIN HOST (+ dev localhost) so link-shortener / proxied routes —
    // whose upstream query semantics this Worker does not control — are never
    // affected (no false positives there).
    const url = new URL(c.req.url);
    const isAdminHost =
      url.hostname === c.env.ADMIN_API_DOMAIN ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1';
    if (isAdminHost && url.search && queryHasTraversal(url.search)) {
      return c.json({ error: 'Not Found', path: c.req.path }, 404);
    }

    await next();
  };
}
