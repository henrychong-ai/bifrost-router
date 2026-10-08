/**
 * The domain every route, QR and slug-stats tool names (v1.40.0: its own
 * module, imported by the route, QR and analytics tools and the dispatcher;
 * it used to live in tools/routes.ts).
 *
 * v1.35.0 — there is no default domain. Every route, QR and slug-stats call
 * names its own domain and nothing fills a missing one in.
 */
import { SUPPORTED_DOMAINS_LIST } from '@bifrost/shared';

/**
 * The dispatcher (dispatch.ts, v1.38.0) answers a missing domain with this
 * error before it validates anything else; the handlers keep the same guard,
 * so a handler called on its own refuses alike, before any client call. The
 * error lists the valid domains so an agent recovers in one retry.
 */
export const NO_DOMAIN_ERROR = `Error: No domain specified. Pass the domain parameter — one of: ${SUPPORTED_DOMAINS_LIST}.`;

/**
 * Returns the caller's domain, or `undefined` when they named none. Takes
 * `unknown`: the dispatcher runs it on the raw JSON-RPC arguments, where a
 * non-string is as reachable as a missing key.
 */
export function requireDomain(domain: unknown): string | undefined {
  return typeof domain === 'string' && domain.length > 0 ? domain : undefined;
}
