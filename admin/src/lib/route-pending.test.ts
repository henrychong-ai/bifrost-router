/**
 * The pending-route store (v1.41.1): this session's own write
 * answers, applied to every route listing when it is read, with no clock
 * comparison anywhere. The clock is vitest's fake one (it drives both
 * `Date.now`, the store's default clock, and the expiry timer). An expiring
 * batch is dropped once its refetch settles, a promise: `advance` runs the
 * timers and then the promise callbacks they started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPendingRouteStore,
  keyOfInput,
  keyOfStored,
  PENDING_ROUTE_EXPIRY_RETRY_MS,
  PENDING_ROUTE_EXPIRY_WINDOW_MS,
  PENDING_ROUTE_TTL_MS,
  type RouteList,
} from './route-pending';
import type { Route, RouteWithDomain } from './schemas';

const HC = 'example.com';
const LINK = 'links.example.com';

function route(overrides: Partial<Route> = {}): Route {
  return {
    path: '/talk',
    type: 'redirect',
    target: 'https://example.com/',
    enabled: true,
    updatedAt: 5,
    ...overrides,
  };
}

const on = (domain: string, overrides: Partial<Route> = {}): RouteWithDomain => ({
  ...route(overrides),
  domain,
});

function list(rows: Route[], invalidRoutes: RouteList['invalidRoutes'] = []): RouteList {
  return {
    routes: rows,
    invalidRoutes,
    total: rows.length + invalidRoutes.length,
    offset: 0,
    hasMore: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
});

/** Run the timers due within `ms`, then the promise callbacks they started. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('an answer replaces the stale row, whatever its stamp', () => {
  it('a stale page shows the answer, and its own row again after 90 s', async () => {
    const store = createPendingRouteStore();
    const stale = list([route({ updatedAt: 5 })]);
    store.observe(on(HC, { enabled: false, updatedAt: 6 }));
    // A domain list's rows carry no domain field of their own: the answer
    // keeps that shape
    expect(store.project(stale, HC).routes).toEqual([route({ enabled: false, updatedAt: 6 })]);
    await advance(PENDING_ROUTE_TTL_MS);
    expect(store.project(stale, HC).routes).toEqual([route({ enabled: false, updatedAt: 6 })]);
    await advance(1);
    expect(store.project(stale, HC)).toBe(stale);
  });

  it('an answer stamped SMALLER than the row still replaces it, and a later smaller one wins', () => {
    const store = createPendingRouteStore();
    const refetched = list([route({ updatedAt: 3000 })]);
    store.observe(on(HC, { target: 'https://b.example/', updatedAt: 2000 }));
    expect(store.project(refetched, HC).routes).toEqual([
      route({ target: 'https://b.example/', updatedAt: 2000 }),
    ]);
    store.observe(on(HC, { target: 'https://c.example/', updatedAt: 1000 }));
    expect(store.project(refetched, HC).routes).toEqual([
      route({ target: 'https://c.example/', updatedAt: 1000 }),
    ]);
  });

  it('a row of another domain at the same path is untouched', () => {
    const store = createPendingRouteStore();
    store.observe(on(HC, { enabled: false }));
    const all = list([on(HC), on(LINK)]);
    expect(store.project(all, undefined).routes).toEqual([on(HC, { enabled: false }), on(LINK)]);
    expect(store.project(list([route()]), LINK).routes).toEqual([route()]);
  });

  it('nothing is added: a listing without the row stays as it is', () => {
    const store = createPendingRouteStore();
    store.observe(on(HC, { path: '/new' }));
    const page = list([route()]);
    expect(store.project(page, HC)).toBe(page);
  });

  // v1.41.1 review: "Showing 9 of 10" after an own delete read 9 of 10
  it('the total drops by the rows hidden; offset and hasMore stay the server’s', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    const page = {
      ...list([route(), route({ path: '/b' })]),
      total: 40,
      offset: 20,
      hasMore: true,
    };
    expect(store.project(page, HC)).toEqual({
      ...page,
      routes: [route({ path: '/b' })],
      total: 39,
    });
  });

  it('“Showing 9 of 10” reads 9 of 9 after an own delete', () => {
    const store = createPendingRouteStore();
    const rows = Array.from({ length: 10 }, (_, index) => route({ path: `/p${index}` }));
    store.markGone(keyOfInput(HC, '/p3'));
    const shown = store.project(list(rows), HC);
    expect(shown.routes).toHaveLength(9);
    expect(shown.total).toBe(9);
  });

  it('counts hidden unreadable rows and answers a search drops; a replaced row keeps it', () => {
    const store = createPendingRouteStore();
    // A recovery delete hides the unreadable row; an answer the search no
    // longer matches leaves it; a saved answer that still matches is shown
    store.markGoneUnreadable(keyOfStored(HC, '/broken'));
    store.observe(on(HC, { path: '/a', target: 'https://moved.test/' }));
    store.observe(on(HC, { path: '/b', updatedAt: 9 }));
    const page = list(
      [route({ path: '/a' }), route({ path: '/b' }), route({ path: '/c' })],
      [{ domain: HC, path: '/broken', invalid: true }],
    );
    const shown = store.project(page, HC, onExampleCom);
    expect(shown.routes.map(row => row.path)).toEqual(['/b', '/c']);
    expect(shown.invalidRoutes).toEqual([]);
    expect(shown.total).toBe(2);
  });

  it('never drops the total below zero (a page whose server total is already behind)', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    expect(store.project({ ...list([route()]), total: 0 }, HC).total).toBe(0);
  });
});

/** A listing's own match: routes still pointing at the example target. */
const onExampleCom = (candidate: RouteWithDomain) => candidate.target === 'https://example.com/';

describe('a key marked gone', () => {
  it('is hidden in a domain list, the all-domains list, a search and a by-target answer', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    expect(store.project(list([route(), route({ path: '/b' })]), HC).routes).toEqual([
      route({ path: '/b' }),
    ]);
    // All domains and a search: rows carry their own domain
    expect(store.project(list([on(HC), on(LINK)]), undefined).routes).toEqual([on(LINK)]);
    expect(store.projectRows([on(HC), on(LINK)])).toEqual([on(LINK)]);
  });

  it('survives a stale refetch, expires at 90 s, and a later answer at the key shows', async () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    vi.advanceTimersByTime(30_000);
    // The refetch still lists it (KV lag): a new raw object, still hidden
    expect(store.project(list([route()]), HC).routes).toEqual([]);
    store.observe(on(HC, { target: 'https://recreated.example/' }));
    expect(store.project(list([route()]), HC).routes).toEqual([
      route({ target: 'https://recreated.example/' }),
    ]);
    store.markGone(keyOfInput(HC, '/talk'));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    const lagging = list([route()]);
    expect(store.project(lagging, HC)).toBe(lagging);
  });

  it('hides the unreadable row at the key too (nothing is stored there)', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    const page = list([], [{ domain: HC, path: '/talk', invalid: true }]);
    expect(store.project(page, HC).invalidRoutes).toEqual([]);
  });
});

describe('a recovery delete (gone-unreadable)', () => {
  it('hides only the unreadable row at its exact key', () => {
    const store = createPendingRouteStore();
    store.markGoneUnreadable(keyOfStored(HC, '/Talk'));
    const invalidRoutes = [
      { domain: HC, path: '/Talk', invalid: true as const },
      { domain: LINK, path: '/Talk', invalid: true as const },
    ];
    const page = list([route({ path: '/Talk', domain: HC })], invalidRoutes);
    const shown = store.project(page, undefined);
    expect(shown.invalidRoutes).toEqual([{ domain: LINK, path: '/Talk', invalid: true }]);
    expect(shown.routes).toEqual([route({ path: '/Talk', domain: HC })]);
    expect(store.projectRows([on(HC, { path: '/Talk' })])).toEqual([on(HC, { path: '/Talk' })]);
  });
});

describe('forget (the server said our version is stale)', () => {
  it('lets the page’s row through, and only a change tells subscribers', () => {
    const store = createPendingRouteStore();
    const listener = vi.fn<() => void>();
    store.subscribe(listener);
    store.observe(on(HC, { enabled: false, updatedAt: 5 }));
    const page = list([route({ updatedAt: 9 })]);
    store.forget(keyOfInput(HC, '/talk'), 5);
    expect(store.project(page, HC)).toBe(page);
    const calls = listener.mock.calls.length;
    store.forget(keyOfInput(HC, '/talk'), 5);
    expect(listener.mock.calls.length).toBe(calls);
  });

  it('forgets only the refused version: another version, or a gone key, is kept', () => {
    const store = createPendingRouteStore();
    store.observe(on(HC, { enabled: false, updatedAt: 6 }));
    // An editor opened on an older copy (5) was refused: our answer (6) stays
    store.forget(keyOfInput(HC, '/talk'), 5);
    expect(store.project(list([route({ updatedAt: 9 })]), HC).routes).toEqual([
      route({ enabled: false, updatedAt: 6 }),
    ]);
    expect(store.size()).toBe(1);
    store.markGone(keyOfInput(HC, '/talk'));
    store.forget(keyOfInput(HC, '/talk'), 6);
    expect(store.project(list([route()]), HC).routes).toEqual([]);
  });
});

describe('a migration and a transfer', () => {
  it('a migration hides the old path and shows the moved route where a row is at its new path', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    store.observe(on(HC, { path: '/new', updatedAt: 8 }));
    const stale = list([route(), route({ path: '/new', updatedAt: 1 })]);
    expect(store.project(stale, HC).routes).toEqual([route({ path: '/new', updatedAt: 8 })]);
  });

  it('a transfer hides the source key and shows the destination row with its domain', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(LINK, '/talk'));
    store.observe(on(HC, { updatedAt: 7 }));
    const all = list([on(LINK), on(HC, { updatedAt: 1 })]);
    expect(store.project(all, undefined).routes).toEqual([on(HC, { updatedAt: 7 })]);
    expect(store.project(list([route()]), LINK).routes).toEqual([]);
    expect(store.projectRows([on(LINK)])).toEqual([]);
  });
});

/** The by-target query's match, for the object `a.pdf` */
const serves = (served: RouteWithDomain) => served.type === 'r2' && served.target === 'a.pdf';

describe('a by-target answer', () => {
  it('shows the saved answer, and drops one that no longer serves the object', () => {
    const store = createPendingRouteStore();
    const row = on(HC, { type: 'r2', target: 'a.pdf', updatedAt: 2 });
    store.observe(on(HC, { type: 'r2', target: 'a.pdf', updatedAt: 3 }));
    expect(store.projectRows([row], serves)).toEqual([
      on(HC, { type: 'r2', target: 'a.pdf', updatedAt: 3 }),
    ]);
    store.observe(on(HC, { type: 'r2', target: 'b.pdf', updatedAt: 4 }));
    expect(store.projectRows([row], serves)).toEqual([]);
  });

  it('is returned as is when nothing applies', () => {
    const store = createPendingRouteStore();
    const rows = [on(HC, { type: 'r2', target: 'a.pdf' })];
    expect(store.projectRows(rows, serves)).toBe(rows);
    store.observe(on(LINK, { path: '/other' }));
    expect(store.projectRows(rows, serves)).toBe(rows);
  });
});

describe('writes in flight (acquire / release / isPending)', () => {
  it('admits a write holding all of its keys, exclusively', () => {
    const store = createPendingRouteStore();
    const before = store.getAdmissionSnapshot();
    const entries = store.getSnapshot();
    const move = store.acquire([keyOfInput(HC, '/talk'), keyOfInput(HC, '/new')]);
    expect(move).not.toBeNull();
    // Its own snapshot changes; the entries' view does not
    expect(store.getAdmissionSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toBe(entries);
    expect(store.getAdmissionSnapshot().isPending(keyOfInput(HC, '/new'))).toBe(true);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(true);
    expect(store.isPending(keyOfInput(LINK, '/talk'))).toBe(false);
    // Any held key refuses the whole write, which then holds nothing
    const held = store.getAdmissionSnapshot();
    expect(store.acquire([keyOfInput(HC, '/other'), keyOfInput(HC, '/new')])).toBeNull();
    expect(store.isPending(keyOfInput(HC, '/other'))).toBe(false);
    expect(store.getAdmissionSnapshot()).toBe(held);
    store.release(move!);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
    expect(store.isPending(keyOfInput(HC, '/new'))).toBe(false);
  });

  it('release frees only its own keys, once', () => {
    const store = createPendingRouteStore();
    const first = store.acquire([keyOfInput(HC, '/talk')])!;
    store.release(first);
    const second = store.acquire([keyOfInput(HC, '/talk')])!;
    const other = store.acquire([keyOfInput(LINK, '/talk')])!;
    // A stale release of the first admission frees nothing the second holds
    const snapshot = store.getAdmissionSnapshot();
    store.release(first);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(true);
    expect(store.getAdmissionSnapshot()).toBe(snapshot);
    store.release(second);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
    expect(store.isPending(keyOfInput(LINK, '/talk'))).toBe(true);
    store.release(other);
  });

  it('a write naming one key twice holds it once', () => {
    const store = createPendingRouteStore();
    const same = store.acquire([keyOfInput(HC, '/talk'), keyOfInput(HC, '/talk')])!;
    expect(same.keys).toHaveLength(1);
    store.release(same);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
  });

  it('are not ended by the TTL', () => {
    const store = createPendingRouteStore();
    store.acquire([keyOfInput(HC, '/talk')]);
    vi.advanceTimersByTime(PENDING_ROUTE_TTL_MS * 3);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(true);
  });

  it('tell only the admission subscribers', () => {
    const store = createPendingRouteStore();
    const entries = vi.fn<() => void>();
    const admission = vi.fn<() => void>();
    store.subscribe(entries);
    const unsubscribe = store.subscribeAdmission(admission);
    const held = store.acquire([keyOfInput(HC, '/talk')])!;
    store.release(held);
    expect(admission).toHaveBeenCalledTimes(2);
    expect(entries).not.toHaveBeenCalled();
    unsubscribe();
    store.acquire([keyOfInput(HC, '/talk')]);
    expect(admission).toHaveBeenCalledTimes(2);
  });
});

describe('generations (a dialog opened before an own answer)', () => {
  it('move whenever an own answer changes the key, and only then', async () => {
    const store = createPendingRouteStore();
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(0);
    store.observe(on(HC, { updatedAt: 6 }));
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(1);
    expect(store.generation(keyOfInput(LINK, '/talk'))).toBe(0);
    store.markGoneUnreadable(keyOfStored(HC, '/talk'));
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(2);
    store.markGone(keyOfInput(HC, '/talk'));
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(3);
    // A forget that keeps the entry changes nothing
    store.forget(keyOfInput(HC, '/talk'), 6);
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(3);
    store.observe(on(HC, { updatedAt: 7 }));
    store.forget(keyOfInput(HC, '/talk'), 7);
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(5);
    // A write in flight and an expiry are not answers
    store.release(store.acquire([keyOfInput(HC, '/talk')])!);
    store.observe(on(HC, { path: '/b' }));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(store.size()).toBe(0);
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(5);
  });
});

describe('an unreadable row at a key holding any entry', () => {
  it('is hidden after a recovery delete and a create at the same key', async () => {
    const store = createPendingRouteStore();
    const page = list([], [{ domain: HC, path: '/talk', invalid: true }]);
    store.markGoneUnreadable(keyOfStored(HC, '/talk'));
    expect(store.project(page, HC).invalidRoutes).toEqual([]);
    // The create's answer overwrites the gone-unreadable entry: the stale
    // unreadable row a lagging refetch still lists stays hidden
    store.observe(on(HC, { updatedAt: 9 }));
    expect(store.project(page, HC).invalidRoutes).toEqual([]);
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(store.project(page, HC)).toBe(page);
  });
});

/** A listing's search, as a match on the target */
const matches = (served: RouteWithDomain) => served.target.includes('keep');

describe('a listing’s own match (its search)', () => {
  it('drops a saved answer the search no longer matches, and keeps one it does', () => {
    const store = createPendingRouteStore();
    const page = list([route({ target: 'https://keep.example/' }), route({ path: '/b' })]);
    store.observe(on(HC, { target: 'https://keep.example/again', updatedAt: 6 }));
    expect(store.project(page, HC, matches).routes).toEqual([
      route({ target: 'https://keep.example/again', updatedAt: 6 }),
      route({ path: '/b' }),
    ]);
    store.observe(on(HC, { target: 'https://elsewhere.example/', updatedAt: 7 }));
    expect(store.project(page, HC, matches).routes).toEqual([route({ path: '/b' })]);
    // Rows without an entry are the server's own matches, never re-checked
    expect(store.project(list([route({ path: '/b' })]), HC, matches).routes).toEqual([
      route({ path: '/b' }),
    ]);
  });
});

/** An expiry listener that refreshed every route query. */
const refreshed = () => true;

describe('expiry refetches (v1.41.1 review: protection until the refetch has refreshed)', () => {
  it('runs each distinct expiry listener once per batch, then drops it and tells subscribers', async () => {
    const store = createPendingRouteStore();
    const order: string[] = [];
    store.subscribe(() => order.push('subscriber'));
    const refetch = vi.fn<() => boolean>(() => {
      order.push('refetch');
      return true;
    });
    const first = store.onExpire(refetch);
    const second = store.onExpire(refetch);
    store.observe(on(HC));
    order.length = 0;
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(order).toEqual(['refetch', 'subscriber']);
    // One registration undone (twice: the second call is a no-op): still runs
    first();
    first();
    store.observe(on(HC));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(refetch).toHaveBeenCalledTimes(2);
    second();
    store.observe(on(HC));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(0);
  });

  // v1.41.1 review: no clock decides whether a query was refreshed
  it('calls each listener with no clock reading', async () => {
    const store = createPendingRouteStore();
    const listener = vi.fn<() => boolean>(() => true);
    store.onExpire(listener);
    store.observe(on(HC));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]).toEqual([]);
  });

  it('keeps the expiring answer projected, and read by dialogs, until the refetch answers', async () => {
    const store = createPendingRouteStore();
    let landed!: (refreshedAll: boolean) => void;
    const refetch = vi.fn<() => Promise<boolean>>(
      () =>
        new Promise<boolean>(resolve => {
          landed = resolve;
        }),
    );
    store.onExpire(refetch);
    const listener = vi.fn<() => void>();
    store.subscribe(listener);
    const stale = list([route({ updatedAt: 1 })]);
    store.observe(on(HC, { enabled: false, updatedAt: 2 }));
    listener.mockClear();
    await advance(PENDING_ROUTE_TTL_MS * 3);
    expect(refetch).toHaveBeenCalledTimes(1);
    // The refetch has not landed: the answer still shows, and still counts
    expect(store.project(stale, HC).routes).toEqual([route({ enabled: false, updatedAt: 2 })]);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({
      state: 'live',
      route: on(HC, { enabled: false, updatedAt: 2 }),
    });
    expect(listener).not.toHaveBeenCalled();
    landed(true);
    await advance(0);
    expect(store.project(stale, HC)).toBe(stale);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // The network is down at expiry: the refetch fails, the listing would show
  // the raw rows cached while KV lagged, so the answer stays and is retried
  it('keeps the batch when a refetch did not refresh, retries it, and drops it after one that did', async () => {
    const store = createPendingRouteStore();
    const online = { now: false };
    const refetch = vi.fn<() => Promise<boolean>>(async () => online.now);
    store.onExpire(refetch);
    const stale = list([route({ updatedAt: 1 })]);
    store.observe(on(HC, { enabled: false, updatedAt: 2 }));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Kept, still projected, and no second refetch before the retry interval
    expect(store.size()).toBe(1);
    expect(store.project(stale, HC).routes).toEqual([route({ enabled: false, updatedAt: 2 })]);
    await advance(PENDING_ROUTE_EXPIRY_RETRY_MS - 10);
    expect(refetch).toHaveBeenCalledTimes(1);
    // The retry fails too: kept again
    await advance(11);
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(1);
    // Back online: the next retry refreshes, and the batch drops
    online.now = true;
    await advance(PENDING_ROUTE_EXPIRY_RETRY_MS + 1);
    expect(refetch).toHaveBeenCalledTimes(3);
    expect(store.size()).toBe(0);
    expect(store.project(stale, HC)).toBe(stale);
  });

  it('keeps the batch when any listener rejects, throws or answers false', async () => {
    for (const failing of [
      () => Promise.reject(new Error('offline')),
      () => {
        throw new Error('broken listener');
      },
      () => false,
    ]) {
      const store = createPendingRouteStore();
      store.onExpire(refreshed);
      store.onExpire(failing);
      store.observe(on(HC));
      await advance(PENDING_ROUTE_TTL_MS + 1);
      expect(store.size()).toBe(1);
      store.clear();
    }
  });

  it('drops the batch at once when no route query is mounted (nothing to refetch)', async () => {
    const store = createPendingRouteStore();
    store.observe(on(HC));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(store.size()).toBe(0);
  });

  it('coalesces a burst: 20 entries due within the window expire with one refetch', async () => {
    const store = createPendingRouteStore();
    const refetch = vi.fn<() => boolean>(refreshed);
    store.onExpire(refetch);
    for (let index = 0; index < 20; index += 1) {
      store.observe(on(HC, { path: `/p${index}` }));
      vi.advanceTimersByTime(200);
    }
    await advance(PENDING_ROUTE_TTL_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(0);
  });

  it('expires entries due further apart than the window in separate batches', async () => {
    const store = createPendingRouteStore();
    const refetch = vi.fn<() => boolean>(refreshed);
    store.onExpire(refetch);
    store.observe(on(HC, { path: '/a' }));
    vi.advanceTimersByTime(PENDING_ROUTE_EXPIRY_WINDOW_MS + 2);
    store.observe(on(HC, { path: '/b' }));
    await advance(PENDING_ROUTE_TTL_MS - PENDING_ROUTE_EXPIRY_WINDOW_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(1);
    await advance(PENDING_ROUTE_EXPIRY_WINDOW_MS + 1);
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(0);
  });

  it('a newer own answer at an expiring key replaces it and is not dropped with the batch', async () => {
    const store = createPendingRouteStore();
    let landed!: (refreshedAll: boolean) => void;
    store.onExpire(
      () =>
        new Promise<boolean>(resolve => {
          landed = resolve;
        }),
    );
    store.observe(on(HC, { updatedAt: 2 }));
    await advance(PENDING_ROUTE_TTL_MS + 1);
    store.observe(on(HC, { updatedAt: 3 }));
    landed(true);
    await advance(0);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({
      state: 'live',
      route: on(HC, { updatedAt: 3 }),
    });
    // It expires on its own TTL
    await advance(PENDING_ROUTE_TTL_MS + 1);
    landed(true);
    await advance(0);
    expect(store.size()).toBe(0);
  });

  it('a late timer (a throttled background tab) expires the overdue entry on its next tick', async () => {
    const store = createPendingRouteStore();
    const refetch = vi.fn<() => boolean>(refreshed);
    store.onExpire(refetch);
    store.observe(on(HC));
    // The clock moved on without the timer firing
    vi.setSystemTime(Date.now() + PENDING_ROUTE_TTL_MS * 2);
    store.observe(on(HC, { path: '/b' }));
    // Still projected until its batch refetches
    expect(store.size()).toBe(2);
    await advance(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toBeUndefined();
    expect(store.answerAt(keyOfStored(HC, '/b'))?.state).toBe('live');
  });
});

describe('keys say which path built them (v1.41.1 review)', () => {
  it('a request’s path is normalised once, as the Worker normalises it, and meets the listed row', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/Promo/'));
    expect(store.project(list([route({ path: '/promo' })]), HC).routes).toEqual([]);
    expect(store.answerAt(keyOfStored(HC, '/promo'))).toEqual({ state: 'gone' });
    expect(store.generation(keyOfInput(HC, '//PROMO/'))).toBe(1);
    store.observe(on(HC, { path: '/promo', updatedAt: 8 }));
    expect(store.projectRows([on(HC, { path: '/promo' })])).toEqual([
      on(HC, { path: '/promo', updatedAt: 8 }),
    ]);
  });

  it('a stored path is used as is: it is never normalised again', () => {
    expect(keyOfStored(HC, '/p?x')).not.toBe(keyOfStored(HC, '/p'));
    // Normalising it again would make it another route
    expect(keyOfInput(HC, '/p?x')).toBe(keyOfStored(HC, '/p'));
    expect(keyOfInput(HC, '/p%3Fx')).toBe(keyOfStored(HC, '/p?x'));
  });

  // `/p%3Fx` was stored as `/p?x`; `/p` is another route
  it('route `/p?x` and route `/p` coexist: a write of one never touches the other’s row', () => {
    const store = createPendingRouteStore();
    const page = list([route({ path: '/p?x' }), route({ path: '/p' })]);
    // A save of `/p` answers `/p`: the `/p?x` row is left alone
    store.observe(on(HC, { path: '/p', enabled: false, updatedAt: 9 }));
    expect(store.project(page, HC).routes).toEqual([
      route({ path: '/p?x' }),
      route({ path: '/p', enabled: false, updatedAt: 9 }),
    ]);
    // A save of `/p?x` answers its stored path: the `/p` row keeps its answer
    store.observe(on(HC, { path: '/p?x', target: 'https://b.example/', updatedAt: 10 }));
    expect(store.project(page, HC).routes).toEqual([
      route({ path: '/p?x', target: 'https://b.example/', updatedAt: 10 }),
      route({ path: '/p', enabled: false, updatedAt: 9 }),
    ]);
    // A delete of `/p` hides `/p` only
    store.markGone(keyOfInput(HC, '/p'));
    expect(store.project(page, HC).routes).toEqual([
      route({ path: '/p?x', target: 'https://b.example/', updatedAt: 10 }),
    ]);
    expect(store.answerAt(keyOfStored(HC, '/p?x'))?.state).toBe('live');
    expect(store.projectRows([on(HC, { path: '/p?x' })])).toEqual([
      on(HC, { path: '/p?x', target: 'https://b.example/', updatedAt: 10 }),
    ]);
  });

  it('a migration’s destination generation, from the typed path, is the key its answer bumps', () => {
    const store = createPendingRouteStore();
    const destination = keyOfInput(HC, '/New-Talk/');
    expect(store.generation(destination)).toBe(0);
    // The Worker stores the normalised path, and answers it
    store.apply([
      { state: 'gone', key: keyOfInput(HC, '/talk') },
      { state: 'live', route: on(HC, { path: '/new-talk', updatedAt: 8 }) },
    ]);
    expect(store.generation(destination)).toBe(1);
  });

  it('admission refuses a write at another spelling of a held route', () => {
    const store = createPendingRouteStore();
    const held = store.acquire([keyOfInput(HC, '/promo')])!;
    expect(store.acquire([keyOfInput(HC, '/Promo/')])).toBeNull();
    expect(store.isPending(keyOfInput(HC, '/PROMO'))).toBe(true);
    expect(store.getAdmissionSnapshot().isPending(keyOfInput(HC, '/promo/'))).toBe(true);
    store.release(held);
  });

  it('an unreadable record keeps its exact key: other spellings neither hide nor hold it', () => {
    const store = createPendingRouteStore();
    const page = list([], [{ domain: HC, path: '/Promo', invalid: true }]);
    // A readable route written at `/promo` is another key than `/Promo`
    store.observe(on(HC, { path: '/promo' }));
    expect(store.project(page, HC).invalidRoutes).toEqual(page.invalidRoutes);
    const recovery = store.acquire([keyOfStored(HC, '/Promo')])!;
    expect(store.isPending(keyOfStored(HC, '/Promo'))).toBe(true);
    expect(store.isPending(keyOfInput(HC, '/promo'))).toBe(false);
    expect(store.acquire([keyOfStored(HC, '/Promo')])).toBeNull();
    store.release(recovery);
    store.markGoneUnreadable(keyOfStored(HC, '/Promo'));
    expect(store.project(page, HC).invalidRoutes).toEqual([]);
    expect(store.answerAt(keyOfStored(HC, '/promo'))?.state).toBe('live');
  });

  // The recovered unreadable `/promo` and a readable `/promo` share one key
  it('a gone-unreadable entry leaves a readable row at the same key as it is', () => {
    const store = createPendingRouteStore();
    store.markGoneUnreadable(keyOfStored(HC, '/promo'));
    const page = list([route({ path: '/promo' })], [{ domain: HC, path: '/promo', invalid: true }]);
    const shown = store.project(page, HC);
    expect(shown.routes).toEqual([route({ path: '/promo' })]);
    expect(shown.invalidRoutes).toEqual([]);
    expect(store.projectRows([on(HC, { path: '/promo' })])).toEqual([on(HC, { path: '/promo' })]);
    expect(store.answerAt(keyOfStored(HC, '/promo'))).toEqual({ state: 'gone-unreadable' });
  });
});

describe('apply (one own answer changing several keys)', () => {
  it('records every key with one snapshot change and one expiry timer', async () => {
    const store = createPendingRouteStore();
    const listener = vi.fn<() => void>();
    store.subscribe(listener);
    const version = store.getSnapshot().version;
    store.apply([
      { state: 'gone', key: keyOfInput(LINK, '/talk') },
      { state: 'live', route: on(HC, { updatedAt: 7 }) },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().version).toBe(version + 1);
    expect(store.answerAt(keyOfStored(LINK, '/talk'))).toEqual({ state: 'gone' });
    expect(store.answerAt(keyOfStored(HC, '/talk'))?.state).toBe('live');
    expect(vi.getTimerCount()).toBe(1);
    // Nothing to record: no change at all
    store.apply([]);
    expect(listener).toHaveBeenCalledTimes(1);
    await advance(PENDING_ROUTE_TTL_MS + 1);
    expect(store.size()).toBe(0);
  });
});

describe('a create that adopted a route read back (v1.41.1 review)', () => {
  it('records the read only at a key holding no entry', () => {
    const store = createPendingRouteStore();
    store.observeReadBack(on(HC, { updatedAt: 1 }));
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({
      state: 'live',
      route: on(HC, { updatedAt: 1 }),
    });
    // This session's own later answer (a disable) wins over a lagging read
    store.observe(on(HC, { enabled: false, updatedAt: 2 }));
    store.observeReadBack(on(HC, { updatedAt: 1 }));
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({
      state: 'live',
      route: on(HC, { enabled: false, updatedAt: 2 }),
    });
    store.markGone(keyOfInput(HC, '/talk'));
    store.observeReadBack(on(HC, { updatedAt: 1 }));
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({ state: 'gone' });
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(3);
  });
});

describe('dropHeld (a write failed with no definite answer)', () => {
  // v1.41.1 review: an uncertain failure is no answer; its own retry must not
  // be refused as a change, so the generations stay
  it('drops every key the write held and leaves their generations', () => {
    const store = createPendingRouteStore();
    store.markGone(keyOfInput(HC, '/talk'));
    store.observe(on(HC, { path: '/other' }));
    const listener = vi.fn<() => void>();
    store.subscribe(listener);
    const move = store.acquire([keyOfInput(HC, '/talk'), keyOfInput(HC, '/new')])!;
    store.dropHeld(move);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toBeUndefined();
    expect(store.answerAt(keyOfStored(HC, '/other'))?.state).toBe('live');
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(1);
    expect(store.generation(keyOfInput(HC, '/new'))).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    // Nothing to drop: no snapshot change
    store.dropHeld(move);
    expect(listener).toHaveBeenCalledTimes(1);
    store.release(move);
  });
});

describe('referential stability and expiry', () => {
  it('returns the listing itself when the store is empty or nothing applies', () => {
    const store = createPendingRouteStore();
    const page = list([route()], [{ domain: HC, path: '/x', invalid: true }]);
    expect(store.project(page, HC)).toBe(page);
    store.markGone(keyOfInput(LINK, '/talk'));
    store.markGoneUnreadable(keyOfStored(HC, '/other'));
    expect(store.project(page, HC)).toBe(page);
  });

  it('tells subscribers when an entry expires, and prunes it', async () => {
    const store = createPendingRouteStore();
    const listener = vi.fn<() => void>();
    const unsubscribe = store.subscribe(listener);
    store.observe(on(HC));
    vi.advanceTimersByTime(10_000);
    store.markGone(keyOfInput(HC, '/other'));
    listener.mockClear();
    await advance(PENDING_ROUTE_TTL_MS - 10_000 + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(1);
    await advance(10_000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(0);
    unsubscribe();
    store.observe(on(HC));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clear forgets entries, writes in flight and generations', () => {
    const store = createPendingRouteStore();
    store.observe(on(HC));
    store.acquire([keyOfInput(HC, '/talk')]);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
    expect(store.generation(keyOfInput(HC, '/talk'))).toBe(0);
  });
});
