/**
 * The one internal-header rule (v1.40.0) for the Worker
 * (`src/utils/internal-headers.ts`) and the dashboard's dev proxy
 * (`admin/dev-api-proxy.ts`): request headers that belong to this deployment
 * and never leave it. They are the admin key, any `X-Bifrost-*` header (the
 * dashboard's request header among them) and the `Tailscale-User-*` identity
 * headers. nginx cannot match a prefix, so the dashboard's nginx template
 * clears the named internal headers ({@link KNOWN_INTERNAL_HEADERS}), and
 * `scripts/check-dashboard-security.test.mjs` checks it against this rule;
 * the Worker never trusts incoming `X-Bifrost-*` headers.
 */

/** Internal headers matched by exact name (lower case). */
export const INTERNAL_HEADER_NAMES = ['x-admin-key'] as const;

/** Internal headers matched by prefix (lower case). */
export const INTERNAL_HEADER_PREFIXES = ['x-bifrost-', 'tailscale-user-'] as const;

/**
 * The internal headers this deployment itself sends or reads, by name: each
 * is one `isInternalHeader` names, and the dashboard's nginx `/api` proxy
 * replaces every one of them with its own value (or none), so a client's copy
 * never reaches the Worker.
 */
export const KNOWN_INTERNAL_HEADERS = [
  'X-Admin-Key',
  'X-Bifrost-Dashboard',
  'Tailscale-User-Login',
  'Tailscale-User-Name',
  'Tailscale-User-Profile-Pic',
] as const;

/** Whether `name` is one of this deployment's own headers (any case). */
export function isInternalHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (INTERNAL_HEADER_NAMES as readonly string[]).includes(lower) ||
    INTERNAL_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))
  );
}
