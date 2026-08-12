import { isCloudflareHealthcheckUserAgent, normalizeAnalyticsPath } from '@bifrost/shared';

export const UNIFIED_TRAFFIC_MAX_LATENCY_MS = 120_000;
export const UNIFIED_TRAFFIC_MAX_CACHE_STATUS_LENGTH = 32;

/** Public template paths contain no private-share bearer capability. */
export function privacySafeUnifiedAnalyticsPath(path: string): string {
  return normalizeAnalyticsPath(path);
}

const AUTOMATION_PATH_PATTERN =
  /(?:^|\/)(?:\.env|\.git|wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|vendor\/phpunit)(?:\/|$)/i;
const AUTOMATION_USER_AGENT_PATTERN =
  /(?:bot(?:\/|\b)|crawler|spider|slurp|curl\/|wget\/|python-requests|go-http-client|headlesschrome)/i;

export function parseUnifiedTrafficCutoverAt(value: string | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return null;
  }
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

export function parseUnifiedTrafficRetentionDays(value: string | undefined): number | null {
  const raw = value?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}

export function isUnifiedTrafficCaptureActive(
  mode: string | undefined,
  cutoverValue: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (mode !== 'shadow') return false;
  const cutoverAt = parseUnifiedTrafficCutoverAt(cutoverValue);
  return cutoverAt !== null && nowSeconds >= cutoverAt;
}

export function isUnifiedTrafficRequestEligible(input: {
  mode: string | undefined;
  cutoverAt: string | undefined;
  hostname: string;
  adminHostname: string | undefined;
  path: string;
  userAgent: string | undefined;
  nowSeconds?: number;
}): boolean {
  if (!isUnifiedTrafficCaptureActive(input.mode, input.cutoverAt, input.nowSeconds)) return false;
  if (input.adminHostname && input.hostname === input.adminHostname) return false;
  if (
    input.path === '/health' ||
    input.path === '/api' ||
    input.path.startsWith('/api/') ||
    input.path === '/.well-known' ||
    input.path.startsWith('/.well-known/')
  ) {
    return false;
  }
  return !isCloudflareHealthcheckUserAgent(input.userAgent);
}

export function classifyUnifiedTraffic(
  path: string,
  userAgent: string | null | undefined,
): 'browser' | 'automation' | 'unknown' {
  if (AUTOMATION_PATH_PATTERN.test(path) || AUTOMATION_USER_AGENT_PATTERN.test(userAgent ?? '')) {
    return 'automation';
  }
  if (userAgent?.includes('Mozilla/')) return 'browser';
  return 'unknown';
}

export function boundedUnifiedCacheStatus(value: string | null | undefined): string | null {
  const normalised = value?.trim().toUpperCase();
  return normalised ? normalised.slice(0, UNIFIED_TRAFFIC_MAX_CACHE_STATUS_LENGTH) : null;
}

export function boundedUnifiedCountry(value: string | null | undefined): string | null {
  const normalised = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{2}$/.test(normalised) ? normalised : null;
}

export function boundedUnifiedLatencyMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), UNIFIED_TRAFFIC_MAX_LATENCY_MS);
}

export function unifiedTrafficOutcome(
  status: number,
): 'redirect' | 'success' | 'client_error' | 'server_error' {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  if (status >= 300) return 'redirect';
  return 'success';
}
