import { SUPPORTED_DOMAINS } from '@bifrost/shared';
import type { FilterState } from '@/components/filters';

/**
 * URL hydration for the analytics pages.
 *
 * Filter state lives in a React context that survives navigation but is invisible
 * to the URL, so a link INTO a page (from Recent Activity, or a bookmark, or a
 * link someone pasted to a colleague) used to land on whatever filters happened
 * to be in memory — the query string was inert. These two helpers make the URL
 * the source of truth on arrival and keep it in step afterwards.
 *
 * Every value is re-validated here rather than trusted: the domain must be a
 * supported one, the period must be an offered preset, the country must be a
 * two-letter code, and the search text is length-clamped. An unrecognised value
 * falls back to the stored filter rather than reaching the API.
 */
const ALLOWED_DAYS = new Set([1, 7, 30, 90, 365]);
const FILTER_KEYS = ['search', 'domain', 'country', 'days'] as const;

export function parseAnalyticsFilterSearchParams(
  params: URLSearchParams,
  fallback: FilterState,
): FilterState {
  // No filter parameters at all means an ordinary in-app navigation: keep
  // whatever the context already holds rather than resetting the page.
  if (!FILTER_KEYS.some(key => params.has(key))) return fallback;

  const rawDomain = params.get('domain') ?? undefined;
  const rawCountry = params.get('country')?.trim().toUpperCase();
  const rawSearch = params.get('search')?.trim().slice(0, 512);
  const rawDays = Number(params.get('days'));

  return {
    search: rawSearch || undefined,
    domain:
      rawDomain && SUPPORTED_DOMAINS.includes(rawDomain as (typeof SUPPORTED_DOMAINS)[number])
        ? rawDomain
        : undefined,
    country: rawCountry && /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : undefined,
    days: ALLOWED_DAYS.has(rawDays) ? rawDays : (fallback.days ?? 1),
  };
}

export function analyticsFiltersToSearchParams(filters: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('days', String(filters.days ?? 1));
  if (filters.search) params.set('search', filters.search);
  if (filters.domain) params.set('domain', filters.domain);
  if (filters.country) params.set('country', filters.country);
  return params;
}
