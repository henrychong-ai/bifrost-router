import { canonicalJson, isRecord } from '@bifrost/shared';
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api-client';
import { isRouteAlreadyExistsError, isRouteSourceChanged, RouteExistsError } from '@/lib/api-error';
import type { CreateRouteInput, Route, UpdateRouteInput } from '@/lib/schemas';

// =============================================================================
// Query Keys
// =============================================================================

export const routeKeys = {
  all: ['routes'] as const,
  list: (domain?: string, search?: string, limit?: number, offset?: number) =>
    ['routes', { domain, search, limit, offset }] as const,
  search: (query: string) => ['routes', 'search', query] as const,
  /** The routes serving one R2 object (Storage's "Associated Routes"); rows carry their domain. */
  byTarget: (bucket: string, target: string) => ['routes', 'by-target', bucket, target] as const,
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
/**
 * After a 409 `ROUTE_SOURCE_CHANGED` (v1.40.0): the route changed since the
 * dashboard loaded it, so the route listings are reloaded and the next edit or
 * move starts from the current version and its `updatedAt`, never resends the
 * stale one. Any other error is left alone. Whether it reloaded.
 */
export function reloadChangedRoute(queryClient: QueryClient, error: unknown): boolean {
  if (!isRouteSourceChanged(error)) return false;
  void queryClient.invalidateQueries({ queryKey: routeKeys.all });
  return true;
}

// =============================================================================
// Cache updates after a successful write (v1.41.0)
// =============================================================================

/** A cached route listing: what `api.routes.list` answers (list, prefetch, search). */
type RouteList = Awaited<ReturnType<typeof api.routes.list>>;

function isRouteList(data: unknown): data is RouteList {
  return isRecord(data) && Array.isArray(data['routes']) && Array.isArray(data['invalidRoutes']);
}

/** Whether cached data is a by-target answer: the routes of one R2 object. */
function isByTargetAnswer(queryKey: QueryKey, data: unknown): data is Route[] {
  return queryKey[1] === 'by-target' && Array.isArray(data) && data.every(row => isRecord(row));
}

/**
 * The domain filter of a `routeKeys.list` key. An all-domains list, a search
 * and a by-target answer have none; their rows carry their own `domain`.
 */
function listDomainOf(queryKey: QueryKey): string | undefined {
  const filters = queryKey[1];
  return isRecord(filters) && typeof filters['domain'] === 'string' ? filters['domain'] : undefined;
}

/** A cached route listing as the cache updates see it (v1.41.0). */
interface CachedListing {
  list: RouteList;
  /** The domain the listing is filtered to; none: its rows carry their own. */
  domain: string | undefined;
}

/**
 * Every cached route listing with data: the page's list, the other domains'
 * prefetches, the all-domains list, a search, and each by-target answer
 * (Storage's "Associated Routes", which "View in Routes" opens the editor
 * from), the last seen as a listing with no domain filter. A listing still
 * loading has no data yet, and is left alone.
 */
function cachedListings(
  queryClient: QueryClient,
): Array<{ queryKey: QueryKey; listing: CachedListing; store: (list: RouteList) => unknown }> {
  const found = [];
  for (const [queryKey, data] of queryClient.getQueriesData<unknown>({ queryKey: routeKeys.all })) {
    if (isRouteList(data)) {
      found.push({
        queryKey,
        listing: { list: data, domain: listDomainOf(queryKey) },
        store: (list: RouteList): unknown => list,
      });
    } else if (isByTargetAnswer(queryKey, data)) {
      const list = {
        routes: data,
        invalidRoutes: [],
        total: data.length,
        offset: 0,
        hasMore: false,
      };
      found.push({
        queryKey,
        listing: { list, domain: undefined },
        store: (edited: RouteList): unknown => edited.routes,
      });
    }
  }
  return found;
}

/** Whether `row` of `listing` is the route at `path` on `domain` (a row with no domain of its own is the listing's). */
function rowIs(listing: CachedListing, row: Route, domain: string, path: string): boolean {
  return row.path === path && (row.domain ?? listing.domain) === domain;
}

/**
 * Apply `edit` to every cached route listing ({@link cachedListings}); it
 * finds the route's rows with {@link rowIs}. A listing `edit` leaves
 * unchanged (it answers undefined) is not written, so its other queries keep
 * their state.
 */
function editRouteLists(
  queryClient: QueryClient,
  edit: (listing: CachedListing) => RouteList | undefined,
): void {
  for (const { queryKey, listing, store } of cachedListings(queryClient)) {
    const next = edit(listing);
    if (next !== undefined) queryClient.setQueryData(queryKey, store(next));
  }
}

function updatedAtOf(route: Route): number {
  return typeof route.updatedAt === 'number' ? route.updatedAt : Number.NEGATIVE_INFINITY;
}

/**
 * Whether a cached row is exactly the version a write superseded or removed
 * (v1.41.0 review): `version` is the `expectedUpdatedAt` the write sent, else
 * the cached version when it started ({@link cachedRouteVersion}). Version
 * IDENTITY only, never clock order: Workers isolates' clocks disagree, so a
 * later write can carry a smaller `updatedAt` than an earlier one, and a
 * delayed older answer a greater one. A row that is any other version (a
 * later write's answer, a refetch, a route re-created there) is left alone,
 * and the invalidation refetch that every write triggers settles it.
 */
function isVersion(row: Route, version: number): boolean {
  return updatedAtOf(row) === version;
}

/** The answer as a row of a listing: the row's own `domain` is kept. */
function asRow(answer: Route, row: Route): Route {
  return row.domain === undefined ? answer : { ...answer, domain: row.domain };
}

/**
 * The cached version of the route at `path` on `domain` when a mutation
 * starts (v1.41.0 review): the newest `updatedAt` any cached listing holds
 * for it, or -Infinity when none does (or none has a timestamp). Read in
 * `onMutate`, before the request: a delete or a transfer removes only a row
 * that is exactly this version ({@link isVersion}), so a route re-created
 * there while the request was in flight, and refetched, is kept whatever its
 * stamp; a toggle (which sends no `expectedUpdatedAt`) names it as the
 * version it superseded.
 */
export function cachedRouteVersion(queryClient: QueryClient, domain: string, path: string): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const { listing } of cachedListings(queryClient)) {
    for (const row of listing.list.routes) {
      if (rowIs(listing, row, domain, path)) newest = Math.max(newest, updatedAtOf(row));
    }
  }
  return newest;
}

/**
 * After an update or a toggle (v1.41.0): the saved route replaces its row,
 * found by domain AND path, in every cached listing (the page's list, the
 * other domains' prefetches, the all-domains list, a search, a by-target
 * answer), only when that row is still exactly the version the write
 * superseded ({@link isVersion}); any other row (a later write's answer, a
 * refetch) is left for the refetch. The editor, the toggle's label and the
 * `enabled` it sends, the Active/Disabled badge and the status filter all
 * read that row, and Storage's "View in Routes" opens the editor from the
 * by-target row, so a route reopened or toggled again before the refetch
 * lands acts on the saved `updatedAt` and `enabled`, never a stale one (which
 * the edit precondition would refuse with a 409). The listings are still
 * invalidated afterwards, and the refetch is the authority.
 */
export function applyRouteSaved(
  queryClient: QueryClient,
  variables: { path: string; domain: string },
  saved: Route,
  superseded: number,
): void {
  editRouteLists(queryClient, listing => {
    const { list } = listing;
    let changed = false;
    const routes = list.routes.map(row => {
      if (!rowIs(listing, row, variables.domain, variables.path) || !isVersion(row, superseded)) {
        return row;
      }
      changed = true;
      return asRow(saved, row);
    });
    return changed ? { ...list, routes } : undefined;
  });
  void queryClient.invalidateQueries({ queryKey: routeKeys.all });
}

/**
 * After a migration: in each listing whose old-path row is still exactly the
 * version the migration superseded ({@link isVersion}; `superseded`: the
 * source's version the migration sent or started from), the moved route takes
 * that row's place, or, when the listing already holds a row at the new path
 * (a refetch landed first), the old row just goes and the new-path row is
 * left alone: it is not a version this migration superseded, and no clock
 * order says which is newer, so the refetch settles it. An old-path row that
 * is any other version (a later route there) stays. A listing that did not
 * hold the old row gains no row (its page and search are the server's to
 * decide; the refetch does).
 */
export function applyRouteMigrated(
  queryClient: QueryClient,
  variables: { oldPath: string; domain: string },
  migrated: Route,
  superseded: number,
): void {
  if (migrated.path === variables.oldPath) {
    applyRouteSaved(
      queryClient,
      { path: variables.oldPath, domain: variables.domain },
      migrated,
      superseded,
    );
    return;
  }
  editRouteLists(queryClient, listing => {
    const { list } = listing;
    const routes = [...list.routes];
    const oldIndex = routes.findIndex(row =>
      rowIs(listing, row, variables.domain, variables.oldPath),
    );
    const old = routes[oldIndex];
    if (!old || !isVersion(old, superseded)) return undefined;
    if (routes.some(row => rowIs(listing, row, variables.domain, migrated.path))) {
      routes.splice(oldIndex, 1);
      return { ...list, routes, total: Math.max(0, list.total - 1) };
    }
    routes[oldIndex] = asRow(migrated, old);
    return { ...list, routes };
  });
  void queryClient.invalidateQueries({ queryKey: routeKeys.all });
}

/**
 * After a delete: the row at `path` on that domain leaves every cached
 * listing, and each listing's total drops by what it lost. Only a row that is
 * exactly `removedUpdatedAt` ({@link cachedRouteVersion}, read when the delete
 * started; {@link isVersion}; v1.41.0 review) goes: any other row, such as a
 * route re-created there since and refetched (whatever its stamp, since
 * isolates' clocks disagree), stays for the refetch, the total unchanged. An
 * unreadable record's
 * recovery delete removes its row from the unreadable rows instead (matched by
 * its exact key, as it was deleted; such a row has no version).
 */
export function applyRouteRemoved(
  queryClient: QueryClient,
  variables: { path: string; domain: string; recoverInvalid?: boolean | undefined },
  removedUpdatedAt: number,
): void {
  editRouteLists(queryClient, listing => {
    const { list } = listing;
    if (variables.recoverInvalid) {
      const invalidRoutes = list.invalidRoutes.filter(
        row => !(row.domain === variables.domain && row.path === variables.path),
      );
      const removed = list.invalidRoutes.length - invalidRoutes.length;
      return removed > 0
        ? { ...list, invalidRoutes, total: Math.max(0, list.total - removed) }
        : undefined;
    }
    const routes = list.routes.filter(
      row =>
        !rowIs(listing, row, variables.domain, variables.path) || !isVersion(row, removedUpdatedAt),
    );
    const removed = list.routes.length - routes.length;
    return removed > 0 ? { ...list, routes, total: Math.max(0, list.total - removed) } : undefined;
  });
  void queryClient.invalidateQueries({ queryKey: routeKeys.all });
}

/**
 * After a transfer (v1.41.0 review), per cached listing, the source row being
 * one at `path` on `fromDomain` that is exactly `removedUpdatedAt` (as for a
 * delete, {@link isVersion}; any other version, such as a route re-created
 * there, stays for the refetch and is never replaced by the moved route):
 *  - a listing with no domain filter (all domains, a search, a by-target
 *    answer) keeps the route where it was, its row now the answer on
 *    `toDomain`, the total unchanged; when it already lists the route on
 *    `toDomain` (a refetch landed first), the source row just goes;
 *  - the source domain's listings lose the row, and their total drops;
 *  - the destination domain's listings are left alone: whether the route
 *    belongs on a page there, and where, is the server's to say, and the
 *    invalidation refetches them.
 */
export function applyRouteTransferred(
  queryClient: QueryClient,
  variables: { path: string; fromDomain: string; toDomain: string },
  transferred: Route,
  removedUpdatedAt: number,
): void {
  const moved: Route = { ...transferred, domain: variables.toDomain };
  editRouteLists(queryClient, listing => {
    const { list } = listing;
    if (listing.domain === variables.toDomain) return undefined;
    const unfiltered = listing.domain === undefined;
    const listedAtDestination =
      unfiltered &&
      list.routes.some(row => rowIs(listing, row, variables.toDomain, transferred.path));
    let rewritten = listedAtDestination;
    let removed = 0;
    const routes: Route[] = [];
    for (const row of list.routes) {
      if (
        !rowIs(listing, row, variables.fromDomain, variables.path) ||
        !isVersion(row, removedUpdatedAt)
      ) {
        routes.push(row);
      } else if (unfiltered && !rewritten) {
        // The same route, now on the destination domain, where it was listed
        routes.push(moved);
        rewritten = true;
      } else {
        removed += 1;
      }
    }
    const changed = removed > 0 || (rewritten && !listedAtDestination);
    return changed ? { ...list, routes, total: Math.max(0, list.total - removed) } : undefined;
  });
  void queryClient.invalidateQueries({ queryKey: routeKeys.all });
}

export function useUpdateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      data,
      domain,
      acknowledgeCredentialTarget,
      expectedUpdatedAt,
    }: {
      path: string;
      data: UpdateRouteInput;
      domain: string;
      /** Set only after the operator confirmed the credential-target dialog. */
      acknowledgeCredentialTarget?: boolean;
      /** The route's `updatedAt` as loaded: a route changed since is refused (v1.40.0). */
      expectedUpdatedAt?: number;
    }) => api.routes.update(path, data, domain, acknowledgeCredentialTarget, expectedUpdatedAt),
    // The version this save supersedes (v1.41.0 review): the one it sent, else the cached one
    onMutate: variables => ({
      superseded:
        variables.expectedUpdatedAt ??
        cachedRouteVersion(queryClient, variables.domain, variables.path),
    }),
    onSuccess: (saved, variables, mutated) =>
      applyRouteSaved(queryClient, variables, saved, mutated?.superseded ?? Number.NaN),
    onError: error => reloadChangedRoute(queryClient, error),
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
    // The version removed is read before the request (v1.41.0 review)
    onMutate: variables => ({
      removedUpdatedAt: cachedRouteVersion(queryClient, variables.domain, variables.path),
    }),
    onSuccess: (_data, variables, mutated) =>
      applyRouteRemoved(
        queryClient,
        variables,
        mutated?.removedUpdatedAt ?? Number.NEGATIVE_INFINITY,
      ),
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
    // A toggle sends no expectedUpdatedAt: it supersedes the cached version (v1.41.0 review)
    onMutate: variables => ({
      superseded: cachedRouteVersion(queryClient, variables.domain, variables.path),
    }),
    onSuccess: (saved, variables, mutated) =>
      applyRouteSaved(queryClient, variables, saved, mutated?.superseded ?? Number.NaN),
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
      expectedUpdatedAt,
    }: {
      oldPath: string;
      newPath: string;
      domain: string;
      /** The rest of the edit, written with the move in one write (v1.38.0). */
      updates?: UpdateRouteInput;
      /** Set only after the operator confirmed the credential-target dialog. */
      acknowledgeCredentialTarget?: boolean;
      /** The source's `updatedAt` as loaded: a route changed since is refused (v1.40.0). */
      expectedUpdatedAt?: number;
    }) =>
      api.routes.migrate(
        oldPath,
        newPath,
        domain,
        updates,
        acknowledgeCredentialTarget,
        expectedUpdatedAt,
      ),
    // The source version this move supersedes (v1.41.0 review), as for a save
    onMutate: variables => ({
      superseded:
        variables.expectedUpdatedAt ??
        cachedRouteVersion(queryClient, variables.domain, variables.oldPath),
    }),
    onSuccess: (migrated, variables, mutated) =>
      applyRouteMigrated(queryClient, variables, migrated, mutated?.superseded ?? Number.NaN),
    onError: error => reloadChangedRoute(queryClient, error),
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
    // The version moved is read before the request (v1.41.0 review)
    onMutate: variables => ({
      removedUpdatedAt: cachedRouteVersion(queryClient, variables.fromDomain, variables.path),
    }),
    onSuccess: (transferred, variables, mutated) =>
      applyRouteTransferred(
        queryClient,
        variables,
        transferred,
        mutated?.removedUpdatedAt ?? Number.NEGATIVE_INFINITY,
      ),
  });
}
