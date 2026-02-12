import type { FilterState } from '@/components/filters';
import type { AuditAction } from '@/lib/schemas';

/**
 * Supported domains for route management
 */
export const SUPPORTED_DOMAINS = [
  'henrychong.com',
  'link.henrychong.com',
  'bifrost.henrychong.com',
  'vanessahung.net',
  'davidchong.co',
  'sonjachong.com',
  'anjachong.com',
  'kitkatcouple.com',
  'valeriehung.com',
] as const;

export type SupportedDomain = (typeof SUPPORTED_DOMAINS)[number];

/**
 * Routes page has different filter fields (client-side filtering + server-side domain)
 */
export interface RoutesFilterState {
  domain?: SupportedDomain;
  search?: string;
  type?: 'redirect' | 'proxy' | 'r2';
  enabled?: boolean;
}

/**
 * Audit page has action filter in addition to standard filters
 */
export interface AuditFilterState extends FilterState {
  action?: AuditAction;
  actor?: string;
}

/**
 * Filter state for each page
 */
export interface PageFilters {
  routes: RoutesFilterState;
  redirects: FilterState;
  views: FilterState;
  downloads: FilterState;
  proxy: FilterState;
  audit: AuditFilterState;
}

export type PageKey = keyof PageFilters;

export interface FilterContextValue {
  /**
   * Get filters for a specific page
   */
  getFilters: <K extends PageKey>(page: K) => PageFilters[K];
  /**
   * Set filters for a specific page
   */
  setFilters: <K extends PageKey>(page: K, filters: PageFilters[K]) => void;
  /**
   * Reset filters for a specific page to defaults
   */
  resetFilters: (page: PageKey) => void;
}

/**
 * Default filter values - analytics pages default to 1 day
 */
export const DEFAULT_FILTERS: PageFilters = {
  routes: {},
  redirects: { days: 1 },
  views: { days: 1 },
  downloads: { days: 1 },
  proxy: { days: 1 },
  audit: { days: 30 },
};
