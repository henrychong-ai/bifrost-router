/**
 * Canonical analytics helpers shared by the Worker, dashboard, and clients.
 *
 * Stored rows are never mutated. Legacy paths are normalised only while
 * building read models, and monitoring rows remain available through an
 * explicit opt-in filter.
 */

/** Stable product token used by Cloudflare Health Checks. */
export const CLOUDFLARE_HEALTHCHECK_UA_TOKEN = 'Cloudflare-Healthchecks/1.0';

/** Stable classifier identifier exposed in analytics metadata. */
export const MONITORING_CLASSIFIER = 'cloudflare-healthchecks' as const;

/** Match only Cloudflare Health Checks, retaining unrelated bots and scanners. */
export function isCloudflareHealthcheckUserAgent(userAgent: string | null | undefined): boolean {
  return userAgent?.includes(CLOUDFLARE_HEALTHCHECK_UA_TOKEN) ?? false;
}

/** Normalise a stored analytics path without allowing authority replacement. */
export function normalizeAnalyticsPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/';
  return `/${trimmed.replace(/^\/+/, '')}`;
}

/** Build a canonical HTTPS source URL from a trusted domain and stored path. */
export function canonicalAnalyticsUrl(domain: string, path: string): string {
  const url = new URL(`https://${domain.trim().toLowerCase()}`);
  url.pathname = normalizeAnalyticsPath(path);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Return a bounded 0..1 leaderboard share. */
export function analyticsShare(count: number, total: number): number {
  if (count <= 0 || total <= 0) return 0;
  return count / total;
}

/** Signed relative percentage; null means there is no prior baseline. */
export function analyticsDeltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}
