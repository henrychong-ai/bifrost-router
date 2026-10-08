/**
 * The `pnpm dev` / `vite preview` side of the dashboard's API proxy (v1.39.0),
 * used by vite.config.ts only: server code, never part of the bundle. The
 * containers do the same in nginx (admin/nginx.conf.template).
 */
import { isInternalHeader } from '@bifrost/shared';
import type { ProxyOptions } from 'vite';
import {
  CROSS_SITE_REFUSAL_BODY,
  crossSiteRefusal,
  type DashboardRequestHeaders,
} from './src/lib/dashboard-request';

/**
 * The paths the dev server proxies to the Worker, and guards: everything
 * below `/api/`, as nginx does. Never bare `/api` (the Worker serves it as an
 * ordinary path, so the key must not go with it) and never `/apix`, which a
 * plain `/api` prefix key would also proxy.
 */
export const DEV_API_PATH = /^\/api\//;

/** The parts of a Node request and response the dev-server guard uses. */
export interface GuardRequest {
  url?: string | undefined;
  headers: DashboardRequestHeaders;
}
export interface GuardResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

/**
 * The dev server's cross-site refusal for /api (`vite.config.ts`), the rule
 * nginx applies in the containers: the dev proxy adds the admin key, so it
 * forwards only the dashboard's own requests. Registered in configureServer,
 * so it runs before Vite's proxy.
 */
export function dashboardApiGuard() {
  return (req: GuardRequest, res: GuardResponse, next: () => void): void => {
    if (DEV_API_PATH.test(req.url ?? '') && crossSiteRefusal(req.headers) !== null) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(CROSS_SITE_REFUSAL_BODY);
      return;
    }
    next();
  };
}

/** The one pathname the dev servers answer locally under /api, as nginx does. */
export const IDENTITY_PATH = '/api/tailscale/identity';

/**
 * Whether a request URL is the identity endpoint: its pathname exactly,
 * whatever query it carries (nginx's `location =` matches the same way), and
 * never a longer path that only starts with it, which goes to the guard and
 * the proxy like any other /api call.
 */
export function isIdentityRequest(url: string | undefined): boolean {
  const query = (url ?? '').indexOf('?');
  return (query === -1 ? url : url?.slice(0, query)) === IDENTITY_PATH;
}

/**
 * The warning the dev and preview servers print when no
 * DASHBOARD_DEV_ADMIN_API_KEY is set, or null when one is: every proxied
 * call then reaches the Worker without a key (401), and a key a client sends
 * is still dropped, never forwarded in its place.
 */
export function missingDevKeyWarning(env: Record<string, string>): string | null {
  return env[`${DEV_ENV_PREFIX}ADMIN_API_KEY`]
    ? null
    : `[dashboard] ${DEV_ENV_PREFIX}ADMIN_API_KEY is not set (admin/.env.local): /api calls ` +
        'reach the Worker without an admin key and are refused (401).';
}

/** The outgoing proxied request, as the dev proxy's `proxyReq` event hands it over. */
export interface ProxiedRequest {
  getHeaderNames(): string[];
  removeHeader(name: string): void;
  setHeader(name: string, value: string): unknown;
}

/**
 * The client headers the dev proxy never forwards by name besides the
 * internal ones (the shared rule above drops any admin key): a front door's
 * credentials, session cookie or access token, as the image's nginx
 * (`Authorization: Bearer <key>` would authenticate at the Worker).
 */
const DROPPED_CLIENT_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'cf-access-jwt-assertion',
  'x-forwarded-access-token',
] as const;

/**
 * The dev proxy's admin key and client headers: any key the client sent is
 * removed, and the dev server's own (DASHBOARD_DEV_ADMIN_API_KEY) is set when
 * there is one, so a client value is never forwarded; a client's
 * credential headers (above), `Tailscale-User-*` and `X-Bifrost-*` headers are
 * removed too.
 */
export function setProxiedAdminKey(proxyReq: ProxiedRequest, key: string | undefined): void {
  // Every internal header by the shared rule (v1.40.0; the Worker's and
  // nginx's too): a client's `Tailscale-User-*` identity (no Tailscale Serve
  // in front of `pnpm dev`, so the Worker would record it as the audit
  // actor), any `X-Bifrost-*` header, and the admin key, as the image's nginx
  for (const name of proxyReq.getHeaderNames()) {
    if (isInternalHeader(name)) proxyReq.removeHeader(name);
  }
  for (const name of DROPPED_CLIENT_HEADERS) proxyReq.removeHeader(name);
  if (key) proxyReq.setHeader('X-Admin-Key', key);
}

/**
 * The prefix of the dev proxy's settings in admin/.env.local (v1.39.0):
 * `DASHBOARD_DEV_API_URL` and `DASHBOARD_DEV_ADMIN_API_KEY`. Never `VITE_`:
 * Vite hands every `VITE_*` variable to any module that reads
 * `import.meta.env`, so a `VITE_` key would reach the browser under `pnpm dev`
 * even with no code naming it. Vite exposes only its `envPrefix` (`VITE_`), so
 * these stay in this Node process.
 */
export const DEV_ENV_PREFIX = 'DASHBOARD_DEV_';

/**
 * The `pnpm dev` / `vite preview` API proxy. The dashboard calls only its own
 * origin and holds no admin key, as in the containers, where nginx proxies
 * /api with the key. Here the dev server does it: /api goes to
 * DASHBOARD_DEV_API_URL (default http://localhost:8787) with X-Admin-Key from
 * DASHBOARD_DEV_ADMIN_API_KEY, replacing any key the client sent (without a
 * configured key, a client's key is dropped, never forwarded).
 * scripts/check-dashboard-security.test.mjs builds with both set and searches
 * the output.
 */
export function devApiProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const key = env[`${DEV_ENV_PREFIX}ADMIN_API_KEY`];
  return {
    [DEV_API_PATH.source]: {
      target: env[`${DEV_ENV_PREFIX}API_URL`] || 'http://localhost:8787',
      changeOrigin: true,
      configure: proxy => {
        proxy.on('proxyReq', proxyReq => setProxiedAdminKey(proxyReq, key));
      },
    },
  };
}
