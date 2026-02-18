import { useContext } from 'react';
import type { FilterState } from '@/components/filters';
import { FilterContext } from './filter-context-value';
import type { RoutesFilterState, AuditFilterState } from './filter-types';

/**
 * Hook to access filter context
 */
export function useFilterContext() {
  const context = useContext(FilterContext);
  if (!context) {
    throw new Error('useFilterContext must be used within a FilterProvider');
  }
  return context;
}

/**
 * Hook for routes page filters
 */
export function useRoutesFilters() {
  const { getFilters, setFilters, resetFilters } = useFilterContext();
  return {
    filters: getFilters('routes'),
    setFilters: (newFilters: RoutesFilterState) =>
      setFilters('routes', newFilters),
    resetFilters: () => resetFilters('routes'),
  };
}

/**
 * Hook for redirects page filters
 */
export function useRedirectsFilters() {
  const { getFilters, setFilters, resetFilters } = useFilterContext();
  return {
    filters: getFilters('redirects'),
    setFilters: (newFilters: FilterState) =>
      setFilters('redirects', newFilters),
    resetFilters: () => resetFilters('redirects'),
  };
}

/**
 * Hook for views page filters
 */
export function useViewsFilters() {
  const { getFilters, setFilters, resetFilters } = useFilterContext();
  return {
    filters: getFilters('views'),
    setFilters: (newFilters: FilterState) => setFilters('views', newFilters),
    resetFilters: () => resetFilters('views'),
  };
}

/**
 * Hook for downloads page filters
 */
export function useDownloadsFilters() {
  const { getFilters, setFilters, resetFilters } = useFilterContext();
  return {
    filters: getFilters('downloads'),
    setFilters: (newFilters: FilterState) =>
      setFilters('downloads', newFilters),
    resetFilters: () => resetFilters('downloads'),
  };
}

/**
 * Hook for proxy page filters
 */
export function useProxyFilters() {
  const { getFilters, setFilters, resetFilters } = useFilterContext();
  return {
    filters: getFilters('proxy'),
    setFilters: (newFilters: FilterState) => setFilters('proxy', newFilters),
    resetFilters: () => resetFilters('proxy'),
  };
}

/**
 * Hook for audit page filters
 */
export function useAuditFilters() {
  const { getFilters, setFilters, resetFilters } = useFilterContext();
  return {
    filters: getFilters('audit'),
    setFilters: (newFilters: AuditFilterState) =>
      setFilters('audit', newFilters),
    resetFilters: () => resetFilters('audit'),
  };
}
