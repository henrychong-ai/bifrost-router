import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { CreateRouteInput, UpdateRouteInput } from '@/lib/schemas';

// =============================================================================
// Query Keys
// =============================================================================

export const routeKeys = {
  all: ['routes'] as const,
  list: (params: { domain?: string; search?: string; limit?: number; offset?: number }) =>
    ['routes', params] as const,
  detail: (path: string) => ['routes', path] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch routes with optional search, filtering, and pagination
 */
export function useRoutes(
  params: { domain?: string; search?: string; limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: routeKeys.list(params),
    queryFn: () => api.routes.list(params),
    placeholderData: keepPreviousData,
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
