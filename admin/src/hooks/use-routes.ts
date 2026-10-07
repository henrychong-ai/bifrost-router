import { canonicalJson } from '@bifrost/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api-client';
import { isRouteAlreadyExistsError, RouteExistsError } from '@/lib/api-error';
import type { CreateRouteInput, Route, UpdateRouteInput } from '@/lib/schemas';

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
 * @param queryOptions - `enabled` gates the fetch (the QR editor's route picker
 *   loads the domain's routes only while a code is linked)
 */
export function useRoutes(
  domain?: string,
  options?: UseRoutesOptions,
  queryOptions?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: routeKeys.list(domain, options?.search, options?.limit, options?.offset),
    queryFn: () => api.routes.list(domain, options),
    enabled: queryOptions?.enabled ?? true,
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
      void queryClient.prefetchQuery({
        queryKey: routeKeys.list(domain, undefined, 1000),
        queryFn: () => api.routes.list(domain, { limit: 1000 }),
        staleTime: 60_000,
      });
    }
  }, [domains, currentDomain, queryClient]);
}

/** Fewest trimmed characters before a cross-domain route search is sent. */
export const MIN_ROUTE_SEARCH_LENGTH = 2;

/**
 * Search routes across all domains for the command palette. The server
 * returns matches ordered by relevance (path matches first), newest first on
 * ties (v1.38.0).
 * @param query - Search term (MIN_ROUTE_SEARCH_LENGTH characters after trimming to trigger)
 */
export function useSearchRoutes(query: string) {
  return useQuery({
    queryKey: routeKeys.search(query),
    queryFn: () => api.routes.list(undefined, { search: query }),
    enabled: query.trim().length >= MIN_ROUTE_SEARCH_LENGTH,
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

/** A route create (v1.38.0): `afterUncertainAnswer` marks a retry, as for a QR create. */
interface RouteCreate {
  data: CreateRouteInput;
  domain: string;
  /** Set only after the operator confirmed the credential-target dialog. */
  acknowledgeCredentialTarget?: boolean | undefined;
  /**
   * A retry of a create of the same path whose earlier answer never arrived
   * (no answer, a 5xx, an unreadable body): that create may have landed.
   */
  afterUncertainAnswer?: boolean | undefined;
}

/**
 * Whether a stored route holds every value a create sent (v1.38.0): each
 * field of the create body, compared as JSON; the path is the one it was read
 * at. The server fills in only what the body leaves out.
 */
function isRouteAsSent(stored: Route, data: CreateRouteInput): boolean {
  return Object.entries(data).every(
    ([field, value]) =>
      field === 'path' ||
      value === undefined ||
      canonicalJson(Object.hasOwn(stored, field) ? stored[field as keyof Route] : undefined) ===
        canonicalJson(value),
  );
}

/**
 * Create a new route. A retry after an uncertain answer that meets 409
 * "Route already exists" reads the route back: when it holds every value sent
 * it is the earlier create, and the create succeeds with it (the QR editor
 * then links it instead of failing every retry); otherwise it is another
 * route, and the create fails with {@link RouteExistsError}, which carries it.
 */
export function createRouteMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: async ({
      data,
      domain,
      acknowledgeCredentialTarget,
      afterUncertainAnswer,
    }: RouteCreate): Promise<Route> => {
      try {
        return await api.routes.create(data, domain, acknowledgeCredentialTarget);
      } catch (error) {
        if (!afterUncertainAnswer || !isRouteAlreadyExistsError(error)) throw error;
        const stored = await api.routes.get(data.path, domain);
        if (!isRouteAsSent(stored, data)) throw new RouteExistsError(stored);
        return stored;
      }
    },
    onSuccess: () => {
      // Invalidate routes list to refetch
      void queryClient.invalidateQueries({ queryKey: routeKeys.all });
    },
  };
}

/**
 * Create a new route
 */
export function useCreateRoute() {
  const queryClient = useQueryClient();
  return useMutation(createRouteMutationOptions(queryClient));
}

/**
 * Update an existing route
 * @param domain - Target domain: required, never defaulted (the route's own in the all-domains view)
 */
export function useUpdateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      data,
      domain,
      acknowledgeCredentialTarget,
    }: {
      path: string;
      data: UpdateRouteInput;
      domain: string;
      /** Set only after the operator confirmed the credential-target dialog. */
      acknowledgeCredentialTarget?: boolean;
    }) => api.routes.update(path, data, domain, acknowledgeCredentialTarget),
    onSuccess: (_data, variables) => {
      // Invalidate both the list and the specific route
      void queryClient.invalidateQueries({ queryKey: routeKeys.all });
      void queryClient.invalidateQueries({
        queryKey: routeKeys.detail(variables.path),
      });
    },
  });
}

/**
 * Delete a route
 * @param domain - Target domain: required, never defaulted (the route's own in the all-domains view)
 */
export function useDeleteRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      domain,
      recoverInvalid,
    }: {
      path: string;
      domain: string;
      /** The exact-key recovery of an unreadable record (v1.38.0). */
      recoverInvalid?: boolean;
    }) => api.routes.delete(path, domain, recoverInvalid ? { recoverInvalid } : {}),
    onSuccess: (_data, variables) => {
      // Invalidate and remove the specific route from cache
      void queryClient.invalidateQueries({ queryKey: routeKeys.all });
      queryClient.removeQueries({ queryKey: routeKeys.detail(variables.path) });
    },
  });
}

/**
 * Toggle route enabled status
 * @param domain - Target domain: required, never defaulted (the route's own in the all-domains view)
 */
export function useToggleRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      enabled,
      domain,
      acknowledgeCredentialTarget,
    }: {
      path: string;
      enabled: boolean;
      domain: string;
      /** Set only after the operator confirmed the credential-target dialog. */
      acknowledgeCredentialTarget?: boolean;
    }) => api.routes.update(path, { enabled }, domain, acknowledgeCredentialTarget),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: routeKeys.all });
      void queryClient.invalidateQueries({
        queryKey: routeKeys.detail(variables.path),
      });
    },
  });
}

/**
 * Migrate a route to a new path, with the rest of an edit in the same write
 */
export function useMigrateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      oldPath,
      newPath,
      domain,
      updates,
      acknowledgeCredentialTarget,
    }: {
      oldPath: string;
      newPath: string;
      domain: string;
      /** The rest of the edit, written with the move in one write (v1.38.0). */
      updates?: UpdateRouteInput;
      /** Set only after the operator confirmed the credential-target dialog. */
      acknowledgeCredentialTarget?: boolean;
    }) => api.routes.migrate(oldPath, newPath, domain, updates, acknowledgeCredentialTarget),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: routeKeys.all });
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
      acknowledgeCredentialTarget,
    }: {
      path: string;
      fromDomain: string;
      toDomain: string;
      /** Set only after the operator confirmed the credential-target dialog. */
      acknowledgeCredentialTarget?: boolean;
    }) => api.routes.transfer(path, fromDomain, toDomain, acknowledgeCredentialTarget),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: routeKeys.all });
    },
  });
}
