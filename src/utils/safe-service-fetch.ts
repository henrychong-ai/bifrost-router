/**
 * Defensive wrapper around service-binding `fetch` calls.
 *
 * Why this exists: in `src/index.ts`, the service-fallback branch
 * forwards to a service binding via `serviceFallback.fetch(new Request(...))`.
 * That single line has two ways to throw:
 *
 *   1. `new Request(req)` — workerd's URL parsing rejects certain malformed
 *      percent-encoded paths (e.g. `%2x` invalid hex pair) with a TypeError.
 *      Vulnerability scanners sometimes use such paths to probe edges.
 *   2. `service.fetch(...)` — the binding itself can fail (binding misconfig,
 *      timeout, runtime error before the inner script runs).
 *
 * Without a wrap, either throw bubbles out of the request handler and
 * surfaces as `scriptThrewException` on this Worker, polluting the
 * Cloudflare Workers error metric. With this wrap, both classes of throw
 * become a `null` return + a `warn`-level log line, so the caller can
 * decide what to serve (typically a synthetic 404).
 *
 * Note: when an INNER Worker (the one behind the service binding) throws,
 * `service.fetch()` does NOT reject — it RESOLVES with a 5xx Response.
 * That case is intentionally NOT handled here: the caller can decide
 * whether to pass the 5xx through or substitute its own response based
 * on its own policy. Pattern-based blocking of scanner traffic that
 * triggers inner exceptions belongs at the Cloudflare WAF layer, not
 * in Worker code.
 */

export interface SafeServiceFetchContext {
  hostname: string;
  path: string;
}

/**
 * Forward `req` to `service` and return the response.
 * Returns `null` on URL-parse error or service-binding failure (and logs at
 * `warn` level with the supplied context).
 */
export async function safeServiceFetch(
  service: Fetcher,
  req: Request,
  context: SafeServiceFetchContext,
): Promise<Response | null> {
  try {
    return await service.fetch(new Request(req));
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'Service binding fetch failed',
        hostname: context.hostname,
        path: context.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}
