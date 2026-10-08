/**
 * Link previews of URLs on this Worker's own domains, resolved in process
 * (v1.37.2).
 *
 * A Worker cannot fetch a host it serves through the public edge: the
 * subrequest never reaches the Worker, so `GET /api/metadata/og` failed
 * (typically 502 or 522) for every link on a supported domain. A preview hop
 * on a supported domain or the admin host (`ADMIN_API_DOMAIN`, so a
 * development deployment previews its own links too) is therefore answered
 * here, from the same KV routes and service bindings the public router uses,
 * as the router would answer a visitor:
 *
 * - redirect route: a 3xx to the destination the redirect handler sends a
 *   visitor to. The parser follows it under its usual hop cap, through the
 *   host policy, and in process again if it lands on an own host. A non-web
 *   destination (`tel:`, `mailto:`) gives the minimal result.
 * - proxy route: the upstream URL, which the parser fetches as a proxied hop
 *   (each redirect checked as a proxy target, under the preview's own 5-hop
 *   cap and timeouts, not the proxy handler's 20), reported
 *   under the public URL, and no error names the upstream (the page's own
 *   og:image may still be an absolute upstream URL). A Host override (fetch cannot send
 *   it, so the page would not be the one a visitor gets) or a refused target
 *   gives the minimal result, and so does an upstream on one of our own hosts
 *   (a visitor would get 502 or 522) or an upstream that passes the redirect
 *   cap; a request path that would leave the target's base path gives 404, as
 *   the handler does.
 * - no route, or a disabled one (the lookup skips it, as the router does): the
 *   service binding's own response if the host has one (a failed binding gives
 *   503, as the router does), else 404. A stored record on the way that cannot
 *   be read gives 404, as the router answers it, never the binding (v1.38.0).
 * - r2 route, a path the Worker answers itself before its routes, or a URL
 *   with userinfo: the minimal result, so nothing about an object or an
 *   internal response is described.
 *
 * Only Worker-level behaviour is reproduced: Cloudflare edge rules (WAF,
 * redirect and transform rules), Access policies and zone-level redirects in
 * front of the Worker are not applied, so a preview can describe a page a
 * visitor would be stopped from reaching. The FQDN spelling (one trailing dot)
 * counts as an own host, but is resolved with its dot, as the router sees it,
 * so it finds no route; a non-default port is not an own host. Nothing here records analytics: a preview is not a
 * visit.
 */

import { getPath } from 'hono/utils/url';
import { proxyDestination } from '../handlers/proxy';
import { redirectDestination, redirectStatus } from '../handlers/redirect';
import { lookupRoute } from '../kv/lookup';
import { isSensitivePath, queryHasTraversal } from '../middleware/sensitive-paths';
import { type Bindings, getServiceFallback, isValidDomain } from '../types';
import { stripTrailingDot } from './host-policy';
import { OPEN_GRAPH_REQUEST_HEADERS, type OwnHostAnswer, type OwnHostResolver } from './og-parser';
import { safeServiceFetch } from './safe-service-fetch';
import { validateProxyTarget } from './url-validation';

/**
 * The paths src/index.ts answers itself, before its KV catch-all, exactly as
 * it matches them (case-sensitive): `GET /.well-known/security.txt`,
 * `/health`, and `/api` and everything under `/api/` (the admin API mount
 * answers `/api` itself too: 404 off the admin host, 401 without a key, and
 * the catch-all 404 with one).
 * Every other `/.well-known/*` path, and other spellings such as `/API` or
 * `/Health`, reach the routes. test/utils/og-own-host-parity.test.ts holds
 * these lists to src/index.ts and to the running Worker.
 */
export const WORKER_ANSWERED_EXACT_PATHS: readonly string[] = [
  '/.well-known/security.txt',
  '/health',
  '/api',
];
export const WORKER_ANSWERED_PREFIXES: readonly string[] = ['/api/'];

/**
 * Whether the Worker answers `path` itself on `host`: the paths above, the
 * source and build paths denySensitivePaths always refuses, and a
 * traversal-shaped query on the admin host. Exported for the parity test.
 */
export function isWorkerAnsweredPath(
  path: string,
  search: string,
  host: string,
  env: Pick<Bindings, 'ADMIN_API_DOMAIN'>,
): boolean {
  return (
    WORKER_ANSWERED_EXACT_PATHS.includes(path) ||
    WORKER_ANSWERED_PREFIXES.some(prefix => path.startsWith(prefix)) ||
    isSensitivePath(path) ||
    (host === env.ADMIN_API_DOMAIN && search !== '' && queryHasTraversal(search))
  );
}

/** A bare response of `status`, as a visitor would get it (no body to describe). */
function statusOnly(status: number): OwnHostAnswer {
  return { kind: 'response', response: new Response(null, { status }) };
}

const MINIMAL: OwnHostAnswer = { kind: 'minimal' };

async function resolveOwnHost(
  url: URL,
  env: Bindings,
  signal: AbortSignal,
): Promise<OwnHostAnswer> {
  if (url.username !== '' || url.password !== '') return MINIMAL;
  // The hostname exactly as the router and denySensitivePaths see it: a
  // trailing dot is kept, so the FQDN spelling finds no route or binding and
  // answers 404, as the router itself would
  const host = url.hostname;
  const requestUrl = url;
  // The path exactly as the router sees it (Hono's `c.req.path`). getPath
  // reads only `url`, so no Request is built: workerd's Request refuses some
  // escapes the URL parser accepts.
  const path = getPath({ url: requestUrl.href } as Request);
  if (isWorkerAnsweredPath(path, requestUrl.search, host, env)) return MINIMAL;

  // The lookup skips a disabled route, as the router does, and an invalid
  // stored record is a 404, never the service binding (v1.38.0)
  const lookup = await lookupRoute(env.ROUTES, host, path);
  if (lookup.status === 'invalid') return statusOnly(404);
  const route = lookup.status === 'ok' ? lookup.route : null;
  if (!route) {
    const binding = getServiceFallback(env, host);
    if (!binding) return statusOnly(404);
    let request: Request;
    try {
      request = new Request(requestUrl.href, {
        // The preview's own fixed headers, none of them internal;
        // safeServiceFetch drops this deployment's internal ones whatever is
        // passed, so they are filtered once, there (v1.40.0)
        headers: OPEN_GRAPH_REQUEST_HEADERS,
        redirect: 'manual',
        signal,
      });
    } catch {
      // workerd refuses some escapes the URL parser accepts; the router's
      // binding call fails the same way, with 503
      return statusOnly(503);
    }
    const forwarded = await safeServiceFetch(binding, request, {
      hostname: host,
      adminKey: env.ADMIN_API_KEY,
    });
    return forwarded ? { kind: 'response', response: forwarded } : statusOnly(503);
  }

  switch (route.type) {
    case 'redirect': {
      let destination: URL | null;
      try {
        destination = redirectDestination(route, requestUrl);
      } catch {
        // A stored target that is not a URL fails the visitor's request too
        return statusOnly(500);
      }
      if (!destination) return statusOnly(404);
      // A tel:, mailto: or other non-web destination has no page to describe
      if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return MINIMAL;
      return {
        kind: 'response',
        response: new Response(null, {
          status: redirectStatus(route),
          headers: { location: destination.href },
        }),
      };
    }
    case 'proxy': {
      if (route.hostHeader || !validateProxyTarget(route.target).valid) return MINIMAL;
      const upstream = proxyDestination(route, requestUrl);
      if (!upstream) return statusOnly(404);
      // A visitor's proxy fetch of one of our own hosts fails (502 or 522)
      return isOwnHost(upstream, env) ? MINIMAL : { kind: 'upstream', url: upstream };
    }
    default:
      return MINIMAL;
  }
}

/**
 * Whether `url` reaches this Worker: a supported domain or the admin host, on
 * the default port. A non-default port is not served by the Worker's custom
 * domains, so it is not an own host. The FQDN spelling (one trailing dot)
 * still reaches the Worker, so it counts as an own host and is never fetched;
 * it is then resolved with its dot, exactly as the router sees it.
 */
function isOwnHost(url: URL, env: Pick<Bindings, 'ADMIN_API_DOMAIN'>): boolean {
  if (url.port !== '') return false;
  const host = stripTrailingDot(url.hostname);
  return isValidDomain(host) || host === env.ADMIN_API_DOMAIN;
}

/**
 * The in-process resolver for this deployment's supported domains and admin
 * host. An unexpected failure (a KV error, say) is logged as fixed text and
 * answered as a bare 502, so no error message reaches the preview response.
 */
export function ownHostResolver(env: Bindings): OwnHostResolver {
  return {
    serves: url => isOwnHost(url, env),
    resolve: async (url, signal) => {
      try {
        return await resolveOwnHost(url, env, signal);
      } catch {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Own-host preview failed',
            host: url.hostname,
          }),
        );
        return statusOnly(502);
      }
    },
  };
}
