import { normalizeRoutePath } from '@bifrost/shared';
import type { InvalidRouteRow, Route, RouteWithDomain } from './schemas';

/**
 * How long the store holds what this session's own write said about a route:
 * KV list results lag a write by up to about 60 seconds, so 90 seconds covers
 * the lag with margin without holding a stale answer for long (as the QR
 * store, `qr-pending.ts`).
 */
export const PENDING_ROUTE_TTL_MS = 90 * 1000;

/**
 * Entries that come due within this long of the first due one expire with it,
 * in one batch with one refetch (v1.41.1 review): a burst of writes ends in
 * one refetch of the route queries, not one per write.
 */
export const PENDING_ROUTE_EXPIRY_WINDOW_MS = 5 * 1000;

/**
 * How long after an expiry refetch that did not refresh every active route
 * query (no network, an error answer, a fetch paused offline, a fetch already
 * in flight when the expiry began) its batch is tried again (v1.41.1
 * review). The batch stays projected meanwhile.
 */
export const PENDING_ROUTE_EXPIRY_RETRY_MS = 30 * 1000;

/** A route listing as the dashboard caches it (`api.routes.list`'s answer). */
export interface RouteList {
  routes: Route[];
  /** The page's rows for stored records that cannot be read (v1.38.0). */
  invalidRoutes: InvalidRouteRow[];
  total: number;
  offset: number;
  hasMore: boolean;
}

/**
 * One route's identity in the store: its domain and the KV key path the
 * Worker stores it at. Built ONLY by {@link keyOfStored} or
 * {@link keyOfInput}, so every caller says which kind of path it holds
 * (v1.41.1 review).
 */
export type RouteStoreKey = string & { readonly __brand: 'RouteStoreKey' };

/**
 * The key of a path as STORED: a listed row's `path`, a write answer's
 * `path`, an unreadable record's exact key. Used as is: the Worker already
 * normalised it when it wrote the record, and `normalizeRoutePath` is not
 * idempotent (`/p%3Fx` is stored as `/p?x`, which would normalise again to
 * `/p`, another route).
 */
export function keyOfStored(domain: string, storedPath: string): RouteStoreKey {
  return `${domain}\u0000${storedPath}` as RouteStoreKey;
}

/**
 * The key of a path as a write REQUEST names it (the operator's input, or a
 * row's path sent back as a request's `path`): normalised ONCE, as the Worker
 * normalises it (`normalizeRoutePath`, its own `normalizePath`) into the key
 * it stores or addresses, so `/Promo/` is `/promo`.
 */
export function keyOfInput(domain: string, inputPath: string): RouteStoreKey {
  return keyOfStored(domain, normalizeRoutePath(inputPath));
}

/**
 * The message of a write refused because another write of this session at
 * one of its routes is still in flight (v1.41.1).
 */
export const ROUTE_WRITE_PENDING_MESSAGE = 'Another change to this route is still saving';

/**
 * A write refused before any request: another write of this session holds
 * one of the routes it affects ({@link PendingRouteStore.acquire}). The route
 * hooks throw it from `onMutate`, so the mutation fails without a request and
 * the page's own error handling shows its message.
 */
export class RouteWritePendingError extends Error {
  readonly code = 'ROUTE_WRITE_PENDING';
  constructor() {
    super(ROUTE_WRITE_PENDING_MESSAGE);
    this.name = 'RouteWritePendingError';
  }
}

/**
 * The routes one write holds, from its `acquire` to its `release`. Opaque:
 * only the store that issued it reads it.
 */
export interface RouteWriteAdmission {
  readonly keys: readonly RouteStoreKey[];
}

/**
 * What this session's last own write at one key said:
 *  - `live`: the route as the write answered it (an update, toggle, create,
 *    or the destination of a migration or transfer);
 *  - `gone`: nothing is stored there any more (a delete, the source of a
 *    migration or transfer);
 *  - `gone-unreadable`: the unreadable record stored there was removed by its
 *    exact key (the recovery delete, `recoverInvalid`). It says nothing about
 *    a readable route at that key: a readable row's projection and a
 *    dialog's staleness check ignore it.
 */
export type PendingRouteAnswer =
  | { state: 'live'; route: RouteWithDomain }
  | { state: 'gone' }
  | { state: 'gone-unreadable' };

/**
 * One own answer to record ({@link PendingRouteStore.apply}): a `live` route
 * at its answer's stored key, or a `gone` / `gone-unreadable` key.
 */
export type OwnRouteAnswer =
  | { state: 'live'; route: RouteWithDomain }
  | { state: 'gone'; key: RouteStoreKey }
  | { state: 'gone-unreadable'; key: RouteStoreKey };

/**
 * An expiry listener: it refetches and says whether every route query it
 * covers was refreshed by that refetch (`true`; the route hooks decide it by
 * counting each query's data writes, never by a clock). Anything else
 * (`false`, a rejection, a throw) keeps the batch for a retry.
 */
export type RouteExpiryListener = () => boolean | Promise<boolean>;

/**
 * `due`: this tab's clock when the entry's expiry comes due (the TTL from the
 * answer, moved on by a failed expiry refetch). The clock only times expiry,
 * never orders two writes.
 */
type Entry = PendingRouteAnswer & { due: number };

/** The answer as a row of its listing, with the row's own `domain` field (present or absent). */
function asRow(route: RouteWithDomain, row: Route): Route {
  if (row.domain !== undefined) return route;
  const copy: Route = { ...route };
  delete copy.domain;
  return copy;
}

/**
 * A read-only view of the store's entries at one version. Its identity
 * changes exactly when the entries change, so it is the `useSyncExternalStore`
 * snapshot and the dependency of each route query's `select`. Writes in
 * flight are NOT part of it ({@link PendingRouteAdmissionView}), so a write
 * starting or settling re-runs no listing's projection.
 */
export interface PendingRouteView {
  readonly version: number;
  /**
   * A listing as the store knows it (see {@link createPendingRouteStore}).
   * `serves` is the listing's own match (its search): a `live` answer that no
   * longer matches leaves the listing. Pure.
   */
  project(
    list: RouteList,
    listDomain: string | undefined,
    serves?: (route: RouteWithDomain) => boolean,
  ): RouteList;
  /** A by-target answer as the store knows it; `serves` is the query's own match. */
  projectRows(
    rows: RouteWithDomain[],
    serves?: (route: RouteWithDomain) => boolean,
  ): RouteWithDomain[];
}

/** The writes in flight at one version (their own snapshot, for disabled buttons). */
export interface PendingRouteAdmissionView {
  readonly version: number;
  /**
   * Whether a write of this session holds the key: {@link keyOfInput} of a
   * readable row's path (what a write of it holds), {@link keyOfStored} of an
   * unreadable row's exact path (what its recovery delete holds).
   */
  isPending(key: RouteStoreKey): boolean;
}

/**
 * What this session's own route writes answered, applied when a route listing
 * is READ (v1.41.1, modelled on the QR store `qr-pending.ts`).
 *
 * It replaces v1.41.0's patching of every cached listing after a write
 * (`applyRouteSaved` and its siblings in `use-routes.ts`), whose rules for
 * which cached row a late answer may replace by version identity failed on
 * listings holding different versions of one route, a change then reverted
 * (the identity matched an older row again), the recovery delete and the
 * by-target rows (the same rules failed review in a sibling deployment's
 * port). Here nothing is ordered by a clock:
 *  - The store is fed ONLY by this session's write answers, never by listing
 *    rows. Each answer overwrites its key's entry, whatever it held: the last
 *    own answer wins. No `updatedAt` or `createdAt` is ever compared for
 *    order (a 409, and a dialog's staleness check, compare one for EQUALITY).
 *    The one exception is a create that adopts an existing route read back
 *    after an uncertain answer ({@link observeReadBack}): a read is not an
 *    answer, so it fills only a key that holds no entry.
 *  - Keys are the Worker's, and say which kind of path built them
 *    ({@link RouteStoreKey}): a path as STORED (a listed row's, a write
 *    answer's, an unreadable record's exact key) is used as is
 *    ({@link keyOfStored}); a path as a write REQUEST names it is normalised
 *    once, as the Worker normalises it ({@link keyOfInput}), so `/Promo/` and
 *    `/promo` are one route, while a stored `/p?x` stays apart from `/p`.
 *  - Writes are exclusive per key: a write's hook calls
 *    {@link acquire} with EVERY key it affects (a migration both paths, a
 *    transfer both domains) before its request, and is refused, acquiring
 *    nothing, when any of them is held; it calls {@link release} with its
 *    own admission once it settles. So two own writes at one key are never
 *    in flight together, and their answers cannot race.
 *  - A dialog compares, at submit, the version it opened with the key's
 *    entry ({@link answerAt}, equality only), and sends nothing when the
 *    entry is gone or holds another `updatedAt` (a `gone-unreadable` entry
 *    says nothing about a readable route, and is ignored). Each key also has
 *    a generation, bumped whenever an own answer changes its entry
 *    ({@link apply} and its shorthands, a {@link forget} that drops one); the
 *    migration confirmation captures its destination's at open and sends
 *    nothing when it moved. An uncertain failure ({@link dropHeld}) does NOT
 *    move it: it is not an answer, and the server's own checks (the
 *    precondition, the destination's existence) guard a retry against a
 *    write that did land.
 *  - An entry ends with its expiry, a later own write at the key, an
 *    uncertain failure of a write holding the key ({@link dropHeld}: it may
 *    have landed), or the server refusing exactly the version the entry
 *    holds: a 409 `ROUTE_SOURCE_CHANGED` to a request whose
 *    `expectedUpdatedAt` equals the entry's `updatedAt` {@link forget}s it
 *    (the refetch then shows the server's row).
 *
 * The React Query cache holds the RAW server listings; each route query's
 * `select` shows them through the current view, which re-runs whenever the
 * entries change. Projection, per row, by the row's stored key (the row's
 * domain, or the listing's, and its path as is): a row whose key is `live`
 * shows the answer (with the row's own `domain` field, present or absent),
 * unless the listing's own match (`serves`: a search, the by-target object)
 * no longer takes it, when it is dropped; a row whose key is `gone` is
 * dropped; a `gone-unreadable` key leaves a readable row as it is. An
 * unreadable row is dropped whenever its exact key holds ANY entry: `gone`
 * (nothing is stored there), `gone-unreadable` (its record was removed), or
 * `live` (a readable route was written there since). Nothing is ever added: a
 * new row (a create, the destination of a migration or transfer) shows when a
 * refetch lists it. The total drops by the rows hidden (min 0); offsets and
 * `hasMore` stay the server's. A listing the store changes nothing in is
 * returned as is (the same object).
 *
 * Expiry (90 s from the answer) keeps the protection until a refetch has
 * refreshed every route query on screen: the entries due within
 * {@link PENDING_ROUTE_EXPIRY_WINDOW_MS} of the first due one are marked
 * expiring (still projected, still read by the dialogs), and the expiry
 * listeners run once for the batch ({@link onExpire}; the route hooks remove
 * every inactive route query there, refetch the active ones, and answer
 * whether each active one was refreshed by a fetch sent after the expiry
 * began, by its count of data writes, with no error). The batch's entries are
 * dropped once every listener answers `true`; otherwise (a listener answers
 * `false`, rejects or throws: no network, an error answer, a fetch already in
 * flight) they stay projected and the batch is tried again
 * {@link PENDING_ROUTE_EXPIRY_RETRY_MS} later. A newer own answer at an
 * expiring key replaces its entry and is kept on its own expiry. What shows
 * after the entries drop is the refetch's result, which still lags when KV
 * lags beyond the 90 s; a removed query mounted again fetches anew.
 *
 * Best effort, by design: another writer's change within the 90 s is masked
 * by this session's answer until a 409 heals it (the editor sends the
 * answer's `updatedAt`, which the server then refuses); a new row shows on
 * the refetch.
 *
 * As for the QR store, this dashboard has no logout or identity switch, so
 * the store lives as long as the tab. The default clock reads `Date.now` at
 * each call, not once at creation, so the dashboard's one store follows a
 * test's fake clock; the clock only times expiry, and never orders two
 * writes or decides whether a query was refreshed.
 */
export function createPendingRouteStore(now: () => number = () => Date.now()) {
  const entries = new Map<RouteStoreKey, Entry>();
  const generations = new Map<RouteStoreKey, number>();
  const admitted = new Map<RouteStoreKey, RouteWriteAdmission>();
  const listeners = new Set<() => void>();
  const admissionListeners = new Set<() => void>();
  /** Expiry listeners, each counted per registration (one call per distinct listener). */
  const expiryListeners = new Map<RouteExpiryListener, number>();
  /** Entries whose expiry refetch is in flight: still projected, settled once it answers. */
  const expiring = new Set<Entry>();
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function project(
    list: RouteList,
    listDomain: string | undefined,
    serves?: (route: RouteWithDomain) => boolean,
  ): RouteList {
    if (entries.size === 0) return list;
    let altered = false;
    const routes: Route[] = [];
    for (const row of list.routes) {
      const domain = row.domain ?? listDomain;
      const entry = domain === undefined ? undefined : entries.get(keyOfStored(domain, row.path));
      if (entry?.state === 'live') {
        altered = true;
        // An answer the listing's search no longer matches leaves it
        if (!serves || serves(entry.route)) routes.push(asRow(entry.route, row));
      } else if (entry?.state === 'gone') {
        altered = true;
      } else {
        routes.push(row);
      }
    }
    // Any own answer at the exact key replaces what was unreadable there
    const invalidRoutes = list.invalidRoutes.filter(
      row => !entries.has(keyOfStored(row.domain, row.path)),
    );
    if (!altered && invalidRoutes.length === list.invalidRoutes.length) return list;
    // The server's total counts every row it lists, the unreadable ones too
    // (v1.41.1 review): each row hidden here leaves it. Offset and `hasMore`
    // stay the server's (the next page is still the server's next page)
    const hidden =
      list.routes.length - routes.length + (list.invalidRoutes.length - invalidRoutes.length);
    return { ...list, routes, invalidRoutes, total: Math.max(0, list.total - hidden) };
  }

  function projectRows(
    rows: RouteWithDomain[],
    serves?: (route: RouteWithDomain) => boolean,
  ): RouteWithDomain[] {
    if (entries.size === 0) return rows;
    let altered = false;
    const out: RouteWithDomain[] = [];
    for (const row of rows) {
      const entry = entries.get(keyOfStored(row.domain, row.path));
      if (entry?.state === 'live') {
        altered = true;
        // An answer that no longer serves the object (its target or type
        // changed) leaves this answer
        if (!serves || serves(entry.route)) out.push(entry.route);
      } else if (entry?.state === 'gone') {
        altered = true;
      } else {
        out.push(row);
      }
    }
    return altered ? out : rows;
  }

  function isPending(key: RouteStoreKey): boolean {
    return admitted.has(key);
  }

  let view: PendingRouteView = { version: 0, project, projectRows };
  let admissionView: PendingRouteAdmissionView = { version: 0, isPending };

  /** A new snapshot of the entries, and every subscriber told: every listing is read again. */
  function changed(): void {
    view = { version: view.version + 1, project, projectRows };
    for (const listener of listeners) listener();
  }

  /** A new snapshot of the writes in flight, and its subscribers told. */
  function admissionChanged(): void {
    admissionView = { version: admissionView.version + 1, isPending };
    for (const listener of admissionListeners) listener();
  }

  /** An own answer changed the key's entry. */
  function bump(key: RouteStoreKey): void {
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }

  /** Wake when the first entry not yet expiring comes due (none: no timer). */
  function schedule(): void {
    if (expiry !== undefined) clearTimeout(expiry);
    expiry = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      if (!expiring.has(entry)) earliest = Math.min(earliest, entry.due);
    }
    if (earliest === Number.POSITIVE_INFINITY) return;
    expiry = setTimeout(
      () => {
        expiry = undefined;
        expire();
      },
      Math.max(0, earliest - now()) + 1,
    );
  }

  /**
   * Every expiry listener once; `true` only when every one answered `true`
   * (a rejection or a throw counts as not refreshed). Never rejects.
   */
  async function refetch(): Promise<boolean> {
    const results = await Promise.allSettled(
      [...expiryListeners.keys()].map(async listener => listener()),
    );
    return results.every(result => result.status === 'fulfilled' && result.value === true);
  }

  /**
   * The due entries, and those due within the window after them, expire as
   * one batch: marked expiring (still projected), one refetch, and settled
   * once it answers ({@link settleExpired}).
   */
  function expire(): void {
    const at = now();
    const batch: Array<[RouteStoreKey, Entry]> = [];
    for (const [key, entry] of entries) {
      if (!expiring.has(entry) && entry.due <= at + PENDING_ROUTE_EXPIRY_WINDOW_MS) {
        batch.push([key, entry]);
      }
    }
    if (batch.length === 0) {
      schedule();
      return;
    }
    for (const [, entry] of batch) expiring.add(entry);
    schedule();
    void refetch().then(refreshed => settleExpired(batch, refreshed));
  }

  /**
   * An expiring batch's refetch answered. Refreshed: drop each entry no newer
   * answer replaced. Not refreshed: keep them (still projected) and try the
   * batch again after the retry interval.
   */
  function settleExpired(
    batch: ReadonlyArray<readonly [RouteStoreKey, Entry]>,
    refreshed: boolean,
  ): void {
    const retryAt = now() + PENDING_ROUTE_EXPIRY_RETRY_MS;
    let dropped = false;
    for (const [key, entry] of batch) {
      expiring.delete(entry);
      if (entries.get(key) !== entry) continue;
      if (refreshed) {
        entries.delete(key);
        dropped = true;
      } else {
        entry.due = retryAt;
      }
    }
    if (dropped) changed();
    schedule();
  }

  /**
   * Record own answers, each overwriting its key's entry (the last own answer
   * wins), with ONE snapshot change and one rescheduling for them all.
   */
  function apply(answers: readonly OwnRouteAnswer[]): void {
    if (answers.length === 0) return;
    const due = now() + PENDING_ROUTE_TTL_MS;
    for (const answer of answers) {
      if (answer.state === 'live') {
        const key = keyOfStored(answer.route.domain, answer.route.path);
        entries.set(key, { state: 'live', route: answer.route, due });
        bump(key);
      } else {
        entries.set(answer.key, { state: answer.state, due });
        bump(answer.key);
      }
    }
    changed();
    schedule();
  }

  return {
    /** For `useSyncExternalStore`: called whenever the entries' snapshot changes. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** The current view of the entries; a new object exactly when they changed. */
    getSnapshot(): PendingRouteView {
      return view;
    },

    /** For `useSyncExternalStore`: called whenever the writes in flight change. */
    subscribeAdmission(listener: () => void): () => void {
      admissionListeners.add(listener);
      return () => {
        admissionListeners.delete(listener);
      };
    },

    /** The writes in flight; a new object exactly when they changed. */
    getAdmissionSnapshot(): PendingRouteAdmissionView {
      return admissionView;
    },

    /**
     * Run `listener` once for each batch of entries coming due; the batch is
     * dropped once every listener has answered `true` (refreshed), and kept
     * for a retry otherwise. Registering the same function again counts; each
     * distinct function runs once per batch, until each registration is
     * undone.
     */
    onExpire(listener: RouteExpiryListener): () => void {
      expiryListeners.set(listener, (expiryListeners.get(listener) ?? 0) + 1);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const count = (expiryListeners.get(listener) ?? 0) - 1;
        if (count > 0) expiryListeners.set(listener, count);
        else expiryListeners.delete(listener);
      };
    },

    apply,

    /** This session's write answered with `route` (its domain set by the caller), at its stored key. */
    observe(route: RouteWithDomain): void {
      apply([{ state: 'live', route }]);
    },

    /**
     * A create that met "already exists" after an uncertain answer read the
     * route back and took it as its own (v1.41.1 review): recorded only when
     * the key holds no entry. An entry there (live or gone) is this session's
     * own later answer, which a read (it may lag) never overwrites.
     */
    observeReadBack(route: RouteWithDomain): void {
      if (!entries.has(keyOfStored(route.domain, route.path))) {
        apply([{ state: 'live', route }]);
      }
    },

    /** Nothing is stored at the key any more, by this session's write (usually {@link keyOfInput}). */
    markGone(key: RouteStoreKey): void {
      apply([{ state: 'gone', key }]);
    },

    /**
     * The unreadable record at the EXACT key ({@link keyOfStored}) was removed
     * by this session's recovery delete: only its unreadable row is hidden.
     */
    markGoneUnreadable(key: RouteStoreKey): void {
      apply([{ state: 'gone-unreadable', key }]);
    },

    /**
     * The server refused a request that expected the route at
     * `refusedUpdatedAt` (409 `ROUTE_SOURCE_CHANGED`): when the key's entry is
     * that very version, it is stale, so the server's rows show again. An
     * entry holding another version (a dialog opened on an older copy than
     * this session's own answer) or a gone key is kept. Equality only.
     */
    forget(key: RouteStoreKey, refusedUpdatedAt: number): void {
      const entry = entries.get(key);
      if (entry?.state !== 'live' || entry.route.updatedAt !== refusedUpdatedAt) return;
      entries.delete(key);
      bump(key);
      changed();
      schedule();
    },

    /**
     * A write holding `admission` failed with no definite answer (no answer,
     * a 5xx, an unreadable body): it may or may not have landed, so the store
     * no longer knows any of its keys. Their entries are dropped (the caller
     * refetches); their generations stay (v1.41.1 review): the failure is no
     * answer, and its own retry must not be refused as a change.
     */
    dropHeld(admission: RouteWriteAdmission): void {
      let dropped = false;
      for (const key of admission.keys) {
        if (entries.delete(key)) dropped = true;
      }
      if (!dropped) return;
      changed();
      schedule();
    },

    /**
     * What this session's own write last said at the key (an expiring entry
     * included), or `undefined`: a dialog compares it at submit with the
     * version it opened (equality only), by the opened route's stored key.
     */
    answerAt(key: RouteStoreKey): PendingRouteAnswer | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      return entry.state === 'live'
        ? { state: 'live', route: entry.route }
        : { state: entry.state };
    },

    /**
     * How many times an own answer changed the key's entry: the migration
     * confirmation compares its destination's ({@link keyOfInput} of the
     * typed path, which equals the stored key the answer bumps) at submit
     * with the value it captured at open (equality only).
     */
    generation(key: RouteStoreKey): number {
      return generations.get(key) ?? 0;
    },

    /**
     * Admit a write affecting every route in `keys` (its hook's `onMutate`):
     * `null`, holding nothing, when a write of this session holds any of
     * them; otherwise its admission, which holds them all until
     * {@link release}.
     */
    acquire(keys: readonly RouteStoreKey[]): RouteWriteAdmission | null {
      const held = [...new Set(keys)];
      if (held.some(key => admitted.has(key))) return null;
      const admission: RouteWriteAdmission = Object.freeze({ keys: Object.freeze(held) });
      for (const key of held) admitted.set(key, admission);
      admissionChanged();
      return admission;
    },

    /** The write settled (its hook's `onSettled`): free the routes it holds, and only those. */
    release(admission: RouteWriteAdmission): void {
      let freed = false;
      for (const key of admission.keys) {
        if (admitted.get(key) === admission) {
          admitted.delete(key);
          freed = true;
        }
      }
      if (freed) admissionChanged();
    },

    isPending,
    project,
    projectRows,

    /** Entries held, expiring ones included until dropped (for tests). */
    size(): number {
      return entries.size;
    },

    /** Forget everything, writes in flight and generations included (for tests). */
    clear(): void {
      entries.clear();
      generations.clear();
      admitted.clear();
      expiring.clear();
      schedule();
      changed();
      admissionChanged();
    },
  };
}

export type PendingRouteStore = ReturnType<typeof createPendingRouteStore>;

/** The dashboard's one store, shared by the route hooks and the Routes page. */
export const pendingRoutes = createPendingRouteStore();
