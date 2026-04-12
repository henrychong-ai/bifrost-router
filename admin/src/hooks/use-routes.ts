import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { CreateRouteInput, UpdateRouteInput } from '@/lib/schemas';

// =============================================================================
// Query Keys
// =============================================================================

export const routeKeys = {
  all: ['routes'] as const,
  list: (domain?: string, search?: string, limit?: number, offset?: number) =>
    ['routes', { domain, search, limit, offset }] as const,
  search: (query: string) => ['routes', 'search', query] as const,
  detail: (path: string) => ['routes', path] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Query options for the routes list
 */
interface UseRoutesOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Fetch all routes for a domain with optional search and pagination
 * @param domain - Optional domain to filter routes
 * @param options - Optional search, limit, and offset parameters
 */
export function useRoutes(domain?: string, options?: UseRoutesOptions) {
  return useQuery({
    queryKey: routeKeys.list(domain, options?.search, options?.limit, options?.offset),
    queryFn: () => api.routes.list(domain, options),
  });
}

/**
 * Prefetch routes for all accessible domains (background, non-blocking).
 * Used for cross-domain duplicate target detection in RouteForm.
 */
export function usePrefetchAllDomainRoutes(domains: readonly string[], currentDomain?: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    for (const domain of domains) {
      if (domain === currentDomain) continue;
      queryClient.prefetchQuery({
        queryKey: routeKeys.list(domain, undefined, 1000),
        queryFn: () => api.routes.list(domain, { limit: 1000 }),
        staleTime: 60_000,
      });
    }
  }, [domains, currentDomain, queryClient]);
}

/**
 * Search routes across all domains for command palette
 * @param query - Search term (min 2 characters to trigger)
 */
export function useSearchRoutes(query: string) {
  return useQuery({
    queryKey: routeKeys.search(query),
    queryFn: () => api.routes.list(undefined, { search: query }),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Fetch a single route by path
 */
export function useRoute(path: string) {
  return useQuery({
    queryKey: routeKeys.detail(path),
    queryFn: () => api.routes.get(path),
    enabled: !!path,
  });
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Create a new route
 */
export function useCreateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ data, domain }: { data: CreateRouteInput; domain?: string }) =>
      api.routes.create(data, domain),
    onSuccess: () => {
      // Invalidate routes list to refetch
      queryClient.invalidateQueries({ queryKey: routeKeys.all });
    },
  });
}

/**
 * Update an existing route
 * @param domain - Target domain from route.domain (required when viewing all domains)
 */
export function useUpdateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      data,
      domain,
    }: {
      path: string;
      data: UpdateRouteInput;
      domain?: string;
    }) => api.routes.update(path, data, domain),
    onSuccess: (_data, variables) => {
      // Invalidate both the list and the specific route
      queryClient.invalidateQueries({ queryKey: routeKeys.all });
      queryClient.invalidateQueries({
        queryKey: routeKeys.detail(variables.path),
      });
    },
  });
}

/**
 * Delete a route
 * @param domain - Target domain from route.domain (required when viewing all domains)
 */
export function useDeleteRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, domain }: { path: string; domain?: string }) =>
      api.routes.delete(path, domain),
    onSuccess: (_data, variables) => {
      // Invalidate and remove the specific route from cache
      queryClient.invalidateQueries({ queryKey: routeKeys.all });
      queryClient.removeQueries({ queryKey: routeKeys.detail(variables.path) });
    },
  });
}

/**
 * Toggle route enabled status
 * @param domain - Target domain from route.domain (required when viewing all domains)
 */
export function useToggleRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, enabled, domain }: { path: string; enabled: boolean; domain?: string }) =>
      api.routes.update(path, { enabled }, domain),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: routeKeys.all });
      queryClient.invalidateQueries({
        queryKey: routeKeys.detail(variables.path),
      });
    },
  });
}

/**
 * Migrate a route to a new path
 */
export function useMigrateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      oldPath,
      newPath,
      domain,
    }: {
      oldPath: string;
      newPath: string;
      domain?: string;
    }) => api.routes.migrate(oldPath, newPath, domain),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: routeKeys.all });
      queryClient.removeQueries({
        queryKey: routeKeys.detail(variables.oldPath),
      });
    },
  });
}

/**
 * Transfer a route to a different domain
 * Preserves path, configuration, and createdAt timestamp
 */
export function useTransferRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      fromDomain,
      toDomain,
    }: {
      path: string;
      fromDomain: string;
      toDomain: string;
    }) => api.routes.transfer(path, fromDomain, toDomain),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: routeKeys.all });
    },
  });
}
