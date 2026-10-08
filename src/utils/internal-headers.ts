/**
 * Request headers that belong to this deployment and never leave it
 * (v1.39.0): the admin key, any `X-Bifrost-*` header (the dashboard's request
 * header among them) and the `Tailscale-User-*` identity headers, which
 * belong to the admin API and the dashboard. A request that carries one to a
 * proxy route, a service-binding fallback or an own-host link preview (a
 * misrouted dashboard call, a visitor who sends one) must not hand it on.
 * One rule for every path that forwards a request: the proxy handler on each
 * hop, `safeServiceFetch`, and the preview resolver. The rule itself lives in
 * `@bifrost/shared` (v1.40.0), shared with the dashboard's dev proxy and
 * checked against the nginx template.
 */
import { isInternalHeader } from '@bifrost/shared';
import { validateApiKey } from './crypto';

/**
 * The admin key an `Authorization` header carries, read exactly as the admin
 * API's authentication reads it: the value with its first `Bearer ` removed
 * (`Authorization: Bearer <key>`, or the bare key).
 */
export function adminKeyFromAuthorization(value: string | undefined): string | undefined {
  return value?.replace('Bearer ', '');
}

/**
 * A copy of `headers` without this deployment's own headers, and without an
 * `Authorization` header that carries the admin key itself (`adminKey`, the
 * Worker's ADMIN_API_KEY; v1.39.0): the admin API accepts the key there too,
 * so a client that sends it to a proxy route or a bound site by mistake must
 * not have it handed on. Any other `Authorization` is the visitor's own and
 * is kept. The value is compared in constant time and never logged.
 */
export function withoutInternalHeaders(headers: HeadersInit, adminKey?: string): Headers {
  const kept = new Headers();
  for (const [name, value] of new Headers(headers)) {
    if (isInternalHeader(name)) continue;
    if (
      name.toLowerCase() === 'authorization' &&
      validateApiKey(adminKeyFromAuthorization(value), adminKey)
    ) {
      continue;
    }
    kept.append(name, value);
  }
  return kept;
}
