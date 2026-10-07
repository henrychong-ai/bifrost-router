/**
 * The dashboard's own API requests (v1.39.0).
 *
 * The dashboard holds no admin key: it calls its own origin, and the server in
 * front of it (nginx in the containers, the Vite dev server under `pnpm dev`)
 * adds `X-Admin-Key` and forwards the call to the Worker. Because that server
 * adds the key to whatever it forwards, it forwards only the dashboard's own
 * requests, never one a page on another site makes a visitor's browser send
 * (a plain `text/plain` or form POST needs no CORS preflight). Every API call
 * the dashboard makes carries {@link DASHBOARD_REQUEST_HEADER}; a page on
 * another origin cannot set a custom header without a preflight, and the
 * preflight lacks it too. The same rule is written twice, here for the dev
 * server and as maps in `admin/nginx.conf.template`;
 * `scripts/check-dashboard-security.test.mjs` keeps the header name in step.
 */

/** The header every dashboard API call sends, and its one accepted value. */
export const DASHBOARD_REQUEST_HEADER = 'X-Bifrost-Dashboard';
export const DASHBOARD_REQUEST_VALUE = '1';

/** Why a request to the key-adding proxy is refused. */
export type CrossSiteRefusal = 'header' | 'site' | 'origin';

/** The request headers the check reads, as Node lower-cases them. */
export interface DashboardRequestHeaders {
  [name: string]: string | string[] | undefined;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Null when the request is the dashboard's own, else why not: the dashboard
 * header missing or not `1`; a `Sec-Fetch-Site` other than `same-origin` (a
 * browser that sends none passes this check); or an `Origin` whose host is
 * not this request's `Host` (no `Origin` passes). The same three checks, in
 * the same order, as nginx's `$bifrost_api_refused`.
 */
export function crossSiteRefusal(headers: DashboardRequestHeaders): CrossSiteRefusal | null {
  if (single(headers[DASHBOARD_REQUEST_HEADER.toLowerCase()]) !== DASHBOARD_REQUEST_VALUE) {
    return 'header';
  }
  const site = single(headers['sec-fetch-site']);
  if (site !== undefined && site !== '' && site !== 'same-origin') return 'site';
  const origin = single(headers['origin']);
  if (origin !== undefined && origin !== '') {
    const host = single(headers['host']) ?? '';
    const match = /^https?:\/\/([^/\s]+)$/i.exec(origin);
    if (!match || host === '' || match[1]?.toLowerCase() !== host.toLowerCase()) return 'origin';
  }
  return null;
}

/** The body of a refused request, as nginx answers it. */
export const CROSS_SITE_REFUSAL_BODY = JSON.stringify({
  success: false,
  error: 'CROSS_SITE_REQUEST',
  message: 'The dashboard API answers only the dashboard itself.',
});
