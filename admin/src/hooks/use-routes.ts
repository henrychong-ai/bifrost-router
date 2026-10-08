import {
  canonicalJson,
  capSearchParam,
  matchesRouteSearch,
  parseSearchQuery,
} from '@bifrost/shared';
import {
  type Query,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '@/lib/api-client';
import {
  ApiError,
  isNotFoundError,
  isRouteAlreadyExistsError,
  isRouteSourceChanged,
  RouteExistsError,
} from '@/lib/api-error';
import {
  keyOfInput,
  keyOfStored,
  type OwnRouteAnswer,
  type PendingRouteStore,
  pendingRoutes,
  type RouteList,
  type RouteStoreKey,
  type RouteWriteAdmission,
  RouteWritePendingError,
} from '@/lib/route-pending';
import type { CreateRouteInput, Route, RouteWithDomain, UpdateRouteInput } from '@/lib/schemas';

// =============================================================================
// Query Keys
// =============================================================================

export const routeKeys = {
  all: ['routes'] as const,
  list: (domain?: string, search?: string, limit?: number, offset?: number) =>
    ['routes', { domain, search, limit, offset }] as const,
  search: (query: string) => ['routes', 'search', query] as const,
  /**
   * The routes serving one R2 object (Storage's "Associated Routes", which
   * "View in Routes" opens the editor from); rows carry their domain. Under
   * `routeKeys.all`, so every route write's invalidation refetches it.
   */
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
 * An active route query's state just before an expiry refetch: how many
 * times its data had been written, and whether a fetch was already in flight
 * (v1.41.1 review). Counts, never a clock.
 */
export interface RouteQueryMark {
  query: Query;
  dataUpdateCount: number;
  wasFetching: boolean;
}

/**
 * Each ACTIVE route query (an enabled observer is mounted; not static, which
 * no refetch touches) as it stands now, for {@link routeQueriesRefreshed}.
 */
export function markActiveRouteQueries(queryClient: QueryClient): RouteQueryMark[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: routeKeys.all, type: 'active' })
    .filter(query => !query.isStatic())
    .map(query => ({
      query,
      dataUpdateCount: query.state.dataUpdateCount,
      wasFetching: query.state.fetchStatus === 'fetching',
    }));
}

/**
 * Whether every marked query was refreshed by a fetch SENT after its mark
 * (v1.41.1 review), by count, never by clock: no error, and its data written
 * once more than when marked, or twice more when a fetch was already in
 * flight then. That fetch may have been sent while KV lagged, and the
 * refetch reuses its promise (a query with no data yet), so its answer does
 * not count. A query holding data whose fetch was in flight is cancelled and
 * fetched again instead (TanStack Query's `cancelRefetch`), so its data is
 * written once, and it counts as not refreshed: conservative, and its batch
 * is retried 30 s later (`PENDING_ROUTE_EXPIRY_RETRY_MS`), when no fetch is in
 * flight. A failed or paused refetch writes no data, so it never counts.
 */
export function routeQueriesRefreshed(marks: readonly RouteQueryMark[]): boolean {
  return marks.every(
    ({ query, dataUpdateCount, wasFetching }) =>
      query.state.error === null &&
      query.state.dataUpdateCount >= dataUpdateCount + (wasFetching ? 2 : 1),
  );
}

/**
 * Each query client's expiry listener, one function per client, so however
 * many route queries register it the store runs it once per expiring batch.
 * It touches only what is on screen (v1.41.1 review):
 *  1. it REMOVES every inactive route query (no enabled observer: a closed
 *     search, an unmounted by-target answer, the other domains' prefetches),
 *     so no unwatched cache can show the raw rows cached while KV lagged once
 *     the batch drops; one mounted again fetches anew;
 *  2. it marks the active ones ({@link markActiveRouteQueries}) and refetches
 *     them;
 *  3. it answers whether they all refreshed ({@link routeQueriesRefreshed}).
 * The store drops the batch only on `true`, and otherwise keeps it projected
 * and retries it 30 s later: a watched query whose refetch keeps failing
 * keeps the batch for as long as it fails.
 */
const expiryRefetches = new WeakMap<QueryClient, () => Promise<boolean>>();

function expiryRefetch(queryClient: QueryClient): () => Promise<boolean> {
  let refetch = expiryRefetches.get(queryClient);
  if (!refetch) {
    refetch = async () => {
      queryClient.removeQueries({ queryKey: routeKeys.all, type: 'inactive' });
      const marks = markActiveRouteQueries(queryClient);
      await queryClient.invalidateQueries({ queryKey: routeKeys.all, refetchType: 'active' });
      return routeQueriesRefreshed(marks);
    };
    expiryRefetches.set(queryClient, refetch);
  }
  return refetch;
}

/**
 * The pending-route store's current view of its entries (lib/route-pending.ts,
 * v1.41.1): a new object whenever they change, so a `select` built on it
 * re-runs then. While mounted it also has the store, when entries expire,
 * remove the inactive route queries and refetch the active ones, and the
 * store drops the entries only once every active one has refreshed (retried
 * every 30 s until they have), so what shows after the 90 s is the
 * refetch's result.
 */
export function usePendingRouteView() {
  const queryClient = useQueryClient();
  useEffect(() => pendingRoutes.onExpire(expiryRefetch(queryClient)), [queryClient]);
  return useSyncExternalStore(pendingRoutes.subscribe, pendingRoutes.getSnapshot);
}

/**
 * The writes of this session in flight, on their own snapshot (v1.41.1): the
 * Routes page re-renders on it to disable a pending route's actions, while
 * listings and their projections depend on the entries only.
 */
export function usePendingRouteAdmission() {
  return useSyncExternalStore(pendingRoutes.subscribeAdmission, pendingRoutes.getAdmissionSnapshot);
}

/**
 * The server's search match for a listing (`matchesRouteSearch`, the shared
 * matcher the Worker's list handler ranks by), over the search as the client
 * sends it (`capSearchParam`): a list of one domain never matches the domain
 * (the Worker searches its rows before attaching it), the all-domains list
 * does. `undefined` when there is no search, so every answer stays.
 */
function listingSearchMatch(
  search: string | undefined,
  listDomain: string | undefined,
): ((route: RouteWithDomain) => boolean) | undefined {
  const query = search === undefined ? null : parseSearchQuery(capSearchParam(search));
  if (!query) return undefined;
  return route =>
    matchesRouteSearch(listDomain === undefined ? route : { ...route, domain: undefined }, query);
}

/**
 * Fetch all routes for a domain with optional search and pagination
 * @param domain - Optional domain to filter routes
 * @param options - Optional search, limit, and offset parameters
 * @param queryOptions - `enabled` gates the fetch (the QR editor's route picker
 *   loads the domain's routes only while a code is linked)
 *
 * The cache holds the RAW server listing; `select` shows it through the
 * pending-route store (v1.41.1), so this session's own writes show in every
 * read of it, before and after a refetch that still lags; with a search, an
 * answer the search no longer matches is dropped. The projection depends only
 * on the store's view of its entries, the domain and the search (strings), so
 * it changes only when one of them does.
 */
export function useRoutes(
  domain?: string,
  options?: UseRoutesOptions,
  queryOptions?: { enabled?: boolean },
) {
  const view = usePendingRouteView();
  const search = options?.search;
  // The search's matcher, built once per search and domain (parsing a search
  // is not free, and `select` runs on every store change)
  const matches = useMemo(() => listingSearchMatch(search, domain), [search, domain]);
  // A saved answer the search no longer matches leaves the listing
  const select = useCallback(
    (list: RouteList) => view.project(list, domain, matches),
    [view, domain, matches],
  );
  return useQuery({
    queryKey: routeKeys.list(domain, options?.search, options?.limit, options?.offset),
    queryFn: () => api.routes.list(domain, options),
    select,
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
 * ties (v1.38.0). Shown through the pending-route store as a listing with no
 * domain filter (v1.41.1).
 * @param query - Search term (MIN_ROUTE_SEARCH_LENGTH characters after trimming to trigger)
 */
export function useSearchRoutes(query: string) {
  const view = usePendingRouteView();
  const matches = useMemo(() => listingSearchMatch(query, undefined), [query]);
  // Rows carry their own domain: the listing has no domain filter. A saved
  // answer the search no longer matches leaves it
  const select = useCallback(
    (list: RouteList) => view.project(list, undefined, matches),
    [view, matches],
  );
  return useQuery({
    queryKey: routeKeys.search(query),
    queryFn: () => api.routes.list(undefined, { search: query }),
    select,
    enabled: query.trim().length >= MIN_ROUTE_SEARCH_LENGTH,
    staleTime: 5 * 60 * 1000,
  });
}

// =============================================================================
// Mutations (v1.41.1: the pending-route store, never patched listings). Each
// write holds EVERY route it affects for its flight (`acquire` in onMutate,
// refused with RouteWritePendingError and no request when another write of
// this session holds any of them; `release` of its own admission in
// onSettled), records its answer in the store on success (one `apply` per
// answer, however many keys it changes), and invalidates every route query;
// the store shows the answer in every listing until it expires. Keys are the
// Worker's: a request's path is normalised once, as the Worker normalises it
// (`keyOfInput`), an answer's path and a recovery delete's exact key are used
// as stored (`keyOfStored`). A failure with no definite answer drops what the
// store knew of every route the write held and refetches; a 409
// ROUTE_SOURCE_CHANGED forgets the route's entry when it is the very version
// the request expected, and a 404 refetches. The option factories are
// exported so tests can run them without a renderer; the hooks install them.
// TODO(v1.41.1 review): one `withAdmission` helper for the five factories'
// shared onMutate/onError/onSettled wiring (TODO.md).
// =============================================================================

/** Refetch every route query (listings, prefetches, searches, by-target answers). */
function invalidateRoutes(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: routeKeys.all });
}

/**
 * Hold every route a write affects, or refuse it before any request (thrown
 * from `onMutate`, the mutation fails without calling its `mutationFn`).
 */
function admit(store: PendingRouteStore, keys: readonly RouteStoreKey[]): RouteWriteAdmission {
  const admission = store.acquire(keys);
  if (!admission) throw new RouteWritePendingError();
  return admission;
}

/** `onSettled`: free what this write holds; a refused write holds nothing. */
function releaseAdmission(store: PendingRouteStore, admission: RouteWriteAdmission | undefined) {
  if (admission) store.release(admission);
}

/**
 * Whether a failure is the server's definite answer, a 4xx refusal: nothing
 * was written. Anything else (no answer, a 5xx, an unreadable body, a 2xx
 * that failed validation) leaves unknown whether the write landed.
 */
function isDefiniteRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/**
 * A failed write holding `admission` (`onError`; `undefined` when it was
 * refused before any request, which changed nothing and leaves the store
 * alone), whose precondition named the route at `refusedAt`:
 *  - no definite answer (no answer, a 5xx, an unreadable body; v1.41.1
 *    review): the write may have landed, so the store drops what it knew of
 *    EVERY route the write held (their generations stay: its own retry is not
 *    a change), and every route query is refetched;
 *  - 409 ROUTE_SOURCE_CHANGED: the server refused `refusedUpdatedAt`, the
 *    version the request expected; the store forgets the entry at
 *    `refusedAt` only when that entry is exactly this version (an editor
 *    opened on an older copy than this session's own answer leaves the
 *    answer), and the listings are refetched, so the next edit starts from
 *    the current version and never resends the stale stamp (v1.40.0). A write
 *    that sent no version (a toggle) forgets nothing;
 *  - a 404: refetched only. The Worker answers a missing route with a bare
 *    `Route not found: …` text and no code, and an unknown endpoint or a
 *    proxy in front of the API answers 404 too, so a 404 never says the route
 *    is gone, and the store never marks it gone from one.
 * Any other refusal changed nothing on the server and leaves the store alone.
 */
function settleFailure(
  queryClient: QueryClient,
  store: PendingRouteStore,
  error: unknown,
  admission: RouteWriteAdmission | undefined,
  refusedAt: RouteStoreKey,
  refusedUpdatedAt?: number,
): void {
  // Refused before any request (RouteWritePendingError, thrown from
  // `onMutate`): TanStack Query then has no context, so `admission` is
  // undefined, and nothing was sent
  if (!admission) return;
  if (!isDefiniteRefusal(error)) {
    store.dropHeld(admission);
    invalidateRoutes(queryClient);
  } else if (isRouteSourceChanged(error)) {
    if (refusedUpdatedAt !== undefined) store.forget(refusedAt, refusedUpdatedAt);
    invalidateRoutes(queryClient);
  } else if (isNotFoundError(error)) {
    invalidateRoutes(queryClient);
  }
}

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
 * A create's result: the route, and whether it was adopted from a read after
 * an uncertain answer rather than answered by this create (v1.41.1 review).
 * Carried in the RESULT, not in state closed over by one render's options:
 * TanStack Query hands a pending mutation each newer render's options, so
 * `onSuccess` may run from options other than the ones that sent it.
 */
export interface CreatedRoute {
  route: Route;
  /** `true`: read back after "already exists", not this create's own answer. */
  readBack: boolean;
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
 * it is the earlier create, and the create succeeds with it (`readBack`; the
 * QR editor then links it instead of failing every retry); otherwise it is
 * another route, and the create fails with {@link RouteExistsError}, which
 * carries it. The created route is recorded in the store; no listing gains a
 * row (it shows when the refetch lists it). A route adopted from that read is
 * recorded only when the store holds nothing at its key (v1.41.1 review): an
 * entry there is this session's own later answer, which a read never
 * overwrites.
 */
export function createRouteMutationOptions(
  queryClient: QueryClient,
  store: PendingRouteStore = pendingRoutes,
) {
  return {
    mutationFn: async ({
      data,
      domain,
      acknowledgeCredentialTarget,
      afterUncertainAnswer,
    }: RouteCreate): Promise<CreatedRoute> => {
      try {
        return {
          route: await api.routes.create(data, domain, acknowledgeCredentialTarget),
          readBack: false,
        };
      } catch (error) {
        if (!afterUncertainAnswer || !isRouteAlreadyExistsError(error)) throw error;
        const stored = await api.routes.get(data.path, domain);
        if (!isRouteAsSent(stored, data)) throw new RouteExistsError(stored);
        return { route: stored, readBack: true };
      }
    },
    onMutate: ({ data, domain }: RouteCreate) => admit(store, [keyOfInput(domain, data.path)]),
    onSuccess: ({ route, readBack }: CreatedRoute, { domain }: RouteCreate) => {
      if (readBack) store.observeReadBack({ ...route, domain });
      else store.observe({ ...route, domain });
      invalidateRoutes(queryClient);
    },
    onError: (
      error: unknown,
      { data, domain }: RouteCreate,
      admission: RouteWriteAdmission | undefined,
    ) => settleFailure(queryClient, store, error, admission, keyOfInput(domain, data.path)),
    onSettled: (
      _data: unknown,
      _error: unknown,
      _variables: RouteCreate,
      admission: RouteWriteAdmission | undefined,
    ) => releaseAdmission(store, admission),
  };
}

interface UpdateVariables {
  path: string;
  data: UpdateRouteInput;
  /** Target domain: required, never defaulted (the route's own in the all-domains view) */
  domain: string;
  /** Set only after the operator confirmed the credential-target dialog. */
  acknowledgeCredentialTarget?: boolean | undefined;
  /** The route's `updatedAt` as loaded: a route changed since is refused (v1.40.0). */
  expectedUpdatedAt?: number | undefined;
}

interface ToggleVariables {
  path: string;
  enabled: boolean;
  /** Target domain: required, never defaulted (the route's own in the all-domains view) */
  domain: string;
  /** Set only after the operator confirmed the credential-target dialog. */
  acknowledgeCredentialTarget?: boolean | undefined;
}

/** A delete; an unreadable record is removed by its EXACT key (v1.38.0). */
interface DeleteVariables {
  path: string;
  /** Target domain: required, never defaulted (the route's own in the all-domains view) */
  domain: string;
  /** The exact-key recovery of an unreadable record (v1.38.0). */
  recoverInvalid?: boolean | undefined;
}

interface MigrateVariables {
  oldPath: string;
  newPath: string;
  domain: string;
  /** The rest of the edit, written with the move in one write (v1.38.0). */
  updates?: UpdateRouteInput | undefined;
  /** Set only after the operator confirmed the credential-target dialog. */
  acknowledgeCredentialTarget?: boolean | undefined;
  /** The source's `updatedAt` as loaded: a route changed since is refused (v1.40.0). */
  expectedUpdatedAt?: number | undefined;
}

interface TransferVariables {
  path: string;
  fromDomain: string;
  toDomain: string;
  /** Set only after the operator confirmed the credential-target dialog. */
  acknowledgeCredentialTarget?: boolean | undefined;
}

/**
 * An update's or a toggle's options: the same store calls around another
 * request. `refusedVersion`: the `updatedAt` the request sent as its
 * precondition, which a 409 refuses (a toggle sends none).
 */
function saveRouteMutationOptions<V extends { path: string; domain: string }>(
  queryClient: QueryClient,
  store: PendingRouteStore,
  mutationFn: (variables: V) => Promise<Route>,
  refusedVersion: (variables: V) => number | undefined,
) {
  return {
    mutationFn,
    onMutate: ({ domain, path }: V) => admit(store, [keyOfInput(domain, path)]),
    onSuccess: (saved: Route, { domain }: V) => {
      store.observe({ ...saved, domain });
      invalidateRoutes(queryClient);
    },
    onError: (error: unknown, variables: V, admission: RouteWriteAdmission | undefined) =>
      settleFailure(
        queryClient,
        store,
        error,
        admission,
        keyOfInput(variables.domain, variables.path),
        refusedVersion(variables),
      ),
    onSettled: (
      _data: unknown,
      _error: unknown,
      _variables: V,
      admission: RouteWriteAdmission | undefined,
    ) => releaseAdmission(store, admission),
  };
}

export function updateRouteMutationOptions(
  queryClient: QueryClient,
  store: PendingRouteStore = pendingRoutes,
) {
  return saveRouteMutationOptions<UpdateVariables>(
    queryClient,
    store,
    ({ path, data, domain, acknowledgeCredentialTarget, expectedUpdatedAt }) =>
      api.routes.update(path, data, domain, acknowledgeCredentialTarget, expectedUpdatedAt),
    ({ expectedUpdatedAt }) => expectedUpdatedAt,
  );
}

export function toggleRouteMutationOptions(
  queryClient: QueryClient,
  store: PendingRouteStore = pendingRoutes,
) {
  return saveRouteMutationOptions<ToggleVariables>(
    queryClient,
    store,
    ({ path, enabled, domain, acknowledgeCredentialTarget }) =>
      api.routes.update(path, { enabled }, domain, acknowledgeCredentialTarget),
    // A toggle sends no precondition: a 409 to it never forgets an entry
    () => undefined,
  );
}

/**
 * The key a delete addresses: the recovery delete names the unreadable
 * record's EXACT stored key (its listed path may not round-trip through the
 * Worker's normalising); an ordinary delete's path is normalised as the
 * Worker normalises it.
 */
const deleteKey = ({ domain, path, recoverInvalid }: DeleteVariables): RouteStoreKey =>
  recoverInvalid ? keyOfStored(domain, path) : keyOfInput(domain, path);

export function deleteRouteMutationOptions(
  queryClient: QueryClient,
  store: PendingRouteStore = pendingRoutes,
) {
  return {
    mutationFn: ({ path, domain, recoverInvalid }: DeleteVariables) =>
      api.routes.delete(path, domain, recoverInvalid ? { recoverInvalid } : {}),
    onMutate: (variables: DeleteVariables) => admit(store, [deleteKey(variables)]),
    // The recovery delete removes the unreadable record at its exact key, so
    // only its unreadable row is hidden
    onSuccess: (_data: unknown, variables: DeleteVariables) => {
      if (variables.recoverInvalid) store.markGoneUnreadable(deleteKey(variables));
      else store.markGone(deleteKey(variables));
      invalidateRoutes(queryClient);
    },
    onError: (
      error: unknown,
      variables: DeleteVariables,
      admission: RouteWriteAdmission | undefined,
    ) => settleFailure(queryClient, store, error, admission, deleteKey(variables)),
    onSettled: (
      _data: unknown,
      _error: unknown,
      _variables: DeleteVariables,
      admission: RouteWriteAdmission | undefined,
    ) => releaseAdmission(store, admission),
  };
}

export function migrateRouteMutationOptions(
  queryClient: QueryClient,
  store: PendingRouteStore = pendingRoutes,
) {
  return {
    mutationFn: ({
      oldPath,
      newPath,
      domain,
      updates,
      acknowledgeCredentialTarget,
      expectedUpdatedAt,
    }: MigrateVariables) =>
      api.routes.migrate(
        oldPath,
        newPath,
        domain,
        updates,
        acknowledgeCredentialTarget,
        expectedUpdatedAt,
      ),
    // Both paths: the route leaves one and lands on the other
    onMutate: ({ domain, oldPath, newPath }: MigrateVariables) =>
      admit(store, [keyOfInput(domain, oldPath), keyOfInput(domain, newPath)]),
    // The old path is gone; the moved route shows where a listing still has
    // a row at its new path, and elsewhere on the refetch. A move to the same
    // key (as the Worker normalises both) is a save: its answer is the entry.
    // One answer, one snapshot change
    onSuccess: (migrated: Route, { domain, oldPath }: MigrateVariables) => {
      const answers: OwnRouteAnswer[] = [];
      const source = keyOfInput(domain, oldPath);
      if (keyOfStored(domain, migrated.path) !== source) {
        answers.push({ state: 'gone', key: source });
      }
      answers.push({ state: 'live', route: { ...migrated, domain } });
      store.apply(answers);
      invalidateRoutes(queryClient);
    },
    onError: (
      error: unknown,
      { domain, oldPath, expectedUpdatedAt }: MigrateVariables,
      admission: RouteWriteAdmission | undefined,
    ) =>
      settleFailure(
        queryClient,
        store,
        error,
        admission,
        keyOfInput(domain, oldPath),
        expectedUpdatedAt,
      ),
    onSettled: (
      _data: unknown,
      _error: unknown,
      _variables: MigrateVariables,
      admission: RouteWriteAdmission | undefined,
    ) => releaseAdmission(store, admission),
  };
}

export function transferRouteMutationOptions(
  queryClient: QueryClient,
  store: PendingRouteStore = pendingRoutes,
) {
  return {
    mutationFn: ({ path, fromDomain, toDomain, acknowledgeCredentialTarget }: TransferVariables) =>
      api.routes.transfer(path, fromDomain, toDomain, acknowledgeCredentialTarget),
    // Both domains: the route leaves one and lands on the other
    onMutate: ({ path, fromDomain, toDomain }: TransferVariables) =>
      admit(store, [keyOfInput(fromDomain, path), keyOfInput(toDomain, path)]),
    // Gone from its old domain; on the new one it shows where a listing still
    // has a row there, and elsewhere on the refetch. One answer, one snapshot
    // change
    onSuccess: (transferred: Route, { path, fromDomain, toDomain }: TransferVariables) => {
      store.apply([
        { state: 'gone', key: keyOfInput(fromDomain, path) },
        { state: 'live', route: { ...transferred, domain: toDomain } },
      ]);
      invalidateRoutes(queryClient);
    },
    onError: (
      error: unknown,
      { path, fromDomain }: TransferVariables,
      admission: RouteWriteAdmission | undefined,
    ) => settleFailure(queryClient, store, error, admission, keyOfInput(fromDomain, path)),
    onSettled: (
      _data: unknown,
      _error: unknown,
      _variables: TransferVariables,
      admission: RouteWriteAdmission | undefined,
    ) => releaseAdmission(store, admission),
  };
}

/** Create a new route */
export function useCreateRoute() {
  return useMutation(createRouteMutationOptions(useQueryClient()));
}

/** Update an existing route (the domain is the route's own in the all-domains view) */
export function useUpdateRoute() {
  return useMutation(updateRouteMutationOptions(useQueryClient()));
}

/** Delete a route, or an unreadable record by its exact key */
export function useDeleteRoute() {
  return useMutation(deleteRouteMutationOptions(useQueryClient()));
}

/** Toggle a route's enabled status */
export function useToggleRoute() {
  return useMutation(toggleRouteMutationOptions(useQueryClient()));
}

/** Migrate a route to a new path, with the rest of an edit in the same write */
export function useMigrateRoute() {
  return useMutation(migrateRouteMutationOptions(useQueryClient()));
}

/**
 * Transfer a route to a different domain
 * Preserves path, configuration, and createdAt timestamp
 */
export function useTransferRoute() {
  return useMutation(transferRouteMutationOptions(useQueryClient()));
}
