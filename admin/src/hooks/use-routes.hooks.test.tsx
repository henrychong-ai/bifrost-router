// @vitest-environment happy-dom

/**
 * The route hooks and the pending-route store (v1.41.1, replacing v1.41.0's
 * patching of the cached listings): each write holds every route it affects
 * for its flight (acquire/release: refused with no request when another
 * write holds one), records its
 * answer (or a 409 verdict) in the store and invalidates the route queries;
 * each route query shows its RAW cached listing through the store. The option factories
 * run against a real QueryClient and their own store; the query hooks are
 * rendered against the dashboard's store, with the API client mocked.
 */
import type * as SharedModule from '@bifrost/shared';
import { parseSearchQuery } from '@bifrost/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The search parser, spied on: a listing's matcher is built once per search
vi.mock('@bifrost/shared', async importOriginal => {
  const actual = await importOriginal<typeof SharedModule>();
  return {
    ...actual,
    parseSearchQuery: vi.fn<typeof actual.parseSearchQuery>(actual.parseSearchQuery),
  };
});
vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://api.example.test' },
}));
vi.mock('@/lib/api-client', () => ({
  api: {
    routes: {
      list: vi.fn<(...args: unknown[]) => unknown>(),
      get: vi.fn<(...args: unknown[]) => unknown>(),
      byTarget: vi.fn<(...args: unknown[]) => unknown>(),
      create: vi.fn<(...args: unknown[]) => unknown>(),
      update: vi.fn<(...args: unknown[]) => unknown>(),
      delete: vi.fn<(...args: unknown[]) => unknown>(),
      migrate: vi.fn<(...args: unknown[]) => unknown>(),
      transfer: vi.fn<(...args: unknown[]) => unknown>(),
    },
  },
}));

import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';
import {
  createPendingRouteStore,
  keyOfInput,
  keyOfStored,
  type OwnRouteAnswer,
  PENDING_ROUTE_EXPIRY_RETRY_MS,
  PENDING_ROUTE_TTL_MS,
  type PendingRouteStore,
  pendingRoutes,
  type RouteStoreKey,
  type RouteWriteAdmission,
  RouteWritePendingError,
} from '@/lib/route-pending';
import type { Route } from '@/lib/schemas';
import {
  createRouteMutationOptions,
  deleteRouteMutationOptions,
  migrateRouteMutationOptions,
  routeKeys,
  toggleRouteMutationOptions,
  transferRouteMutationOptions,
  updateRouteMutationOptions,
  useCreateRoute,
  useDeleteRoute,
  useMigrateRoute,
  useRoutes,
  useSearchRoutes,
  useToggleRoute,
  useTransferRoute,
  useUpdateRoute,
} from './use-routes';
import { useRoutesByTarget } from './use-storage';

const routes = vi.mocked(api.routes);
const HC = 'example.com';
const LINK = 'links.example.com';

function route(overrides: Partial<Route> = {}): Route {
  return {
    path: '/talk',
    type: 'redirect',
    target: 'https://example.com/',
    updatedAt: 5,
    ...overrides,
  };
}

function list(rows: Route[]) {
  return { routes: rows, invalidRoutes: [], total: rows.length, offset: 0, hasMore: false };
}

let client: QueryClient;
let store: PendingRouteStore;
let calls: string[];

/** A store key as `domain path`. */
const shownKey = (key: string) => key.replace('\u0000', ' ');

/** `fn`, each call recorded in `calls` as `name arg …` (objects as JSON, keys as `domain path`). */
const spy =
  <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
  (...args: A) => {
    const shown = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : shownKey(String(arg)),
    );
    calls.push([name, ...shown].join(' '));
    fn(...args);
  };

/** Keys as `domain path …`. */
const keysOf = (keys: readonly RouteStoreKey[]) => keys.map(shownKey).join(' ');

/** One answer of an `apply`, as the single-answer call that records it. */
const shownAnswer = (answer: OwnRouteAnswer) =>
  answer.state === 'live'
    ? `observe ${JSON.stringify(answer.route)}`
    : `${answer.state === 'gone' ? 'markGone' : 'markGoneUnreadable'} ${shownKey(answer.key)}`;

/**
 * The store, each call to it recorded in order (`acquire HC /talk`,
 * `observe …`, `release HC /talk`; a refused acquire as `refused …`).
 */
function recordingStore(): PendingRouteStore {
  const base = createPendingRouteStore();
  const held = new Map<RouteWriteAdmission, string>();
  return {
    ...base,
    acquire: (keys: readonly RouteStoreKey[]) => {
      const admission = base.acquire(keys);
      calls.push(`${admission ? 'acquire' : 'refused'} ${keysOf(keys)}`);
      if (admission) held.set(admission, keysOf(keys));
      return admission;
    },
    release: (admission: RouteWriteAdmission) => {
      calls.push(`release ${held.get(admission)}`);
      base.release(admission);
    },
    observe: spy('observe', base.observe),
    observeReadBack: spy('observeReadBack', base.observeReadBack),
    markGone: spy('markGone', base.markGone),
    markGoneUnreadable: spy('markGoneUnreadable', base.markGoneUnreadable),
    apply: (answers: readonly OwnRouteAnswer[]) => {
      calls.push(`apply ${answers.map(shownAnswer).join('; ')}`);
      base.apply(answers);
    },
    forget: spy('forget', base.forget),
    dropHeld: (admission: RouteWriteAdmission) => {
      calls.push(`dropHeld ${held.get(admission)}`);
      base.dropHeld(admission);
    },
  };
}

/** Run a mutation's options as `useMutation` would, without a renderer. */
function run<V>(options: object, variables: V): Promise<unknown> {
  return client.getMutationCache().build(client, options).execute(variables);
}

beforeEach(() => {
  for (const mock of Object.values(routes)) mock.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
  store = recordingStore();
});

describe('each write records its answer in the store, inside acquire/release', () => {
  it('an update and a toggle observe the answer on the write’s domain', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    routes.update.mockResolvedValueOnce(route({ updatedAt: 6 }));
    await run(updateRouteMutationOptions(client, store), { path: '/talk', data: {}, domain: HC });
    routes.update.mockResolvedValueOnce(route({ enabled: false, updatedAt: 7 }));
    await run(toggleRouteMutationOptions(client, store), {
      path: '/talk',
      enabled: false,
      domain: HC,
    });
    expect(calls).toEqual([
      `acquire ${HC} /talk`,
      `observe ${JSON.stringify({ ...route({ updatedAt: 6 }), domain: HC })}`,
      `release ${HC} /talk`,
      `acquire ${HC} /talk`,
      `observe ${JSON.stringify({ ...route({ enabled: false, updatedAt: 7 }), domain: HC })}`,
      `release ${HC} /talk`,
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: routeKeys.all });
  });

  it('a create observes the created route; no listing gains a row', async () => {
    routes.create.mockResolvedValueOnce(route({ path: '/new' }));
    await run(createRouteMutationOptions(client, store), {
      data: { path: '/new', type: 'redirect', target: 'https://example.com/' },
      domain: HC,
    });
    expect(calls).toEqual([
      `acquire ${HC} /new`,
      `observe ${JSON.stringify({ ...route({ path: '/new' }), domain: HC })}`,
      `release ${HC} /new`,
    ]);
  });

  it('a delete marks the key gone; a recovery delete only its unreadable row', async () => {
    routes.delete.mockResolvedValueOnce(undefined);
    await run(deleteRouteMutationOptions(client, store), { path: '/talk', domain: HC });
    routes.delete.mockResolvedValueOnce(undefined);
    await run(deleteRouteMutationOptions(client, store), {
      path: '/Talk',
      domain: HC,
      recoverInvalid: true,
    });
    expect(routes.delete.mock.calls).toEqual([
      ['/talk', HC, {}],
      ['/Talk', HC, { recoverInvalid: true }],
    ]);
    expect(calls).toEqual([
      `acquire ${HC} /talk`,
      `markGone ${HC} /talk`,
      `release ${HC} /talk`,
      `acquire ${HC} /Talk`,
      `markGoneUnreadable ${HC} /Talk`,
      `release ${HC} /Talk`,
    ]);
  });

  it('a migration marks the old path gone and observes the moved route', async () => {
    routes.migrate.mockResolvedValueOnce(route({ path: '/new', updatedAt: 8 }));
    await run(migrateRouteMutationOptions(client, store), {
      oldPath: '/talk',
      newPath: '/new',
      domain: HC,
      expectedUpdatedAt: 5,
    });
    expect(routes.migrate).toHaveBeenCalledWith('/talk', '/new', HC, undefined, undefined, 5);
    expect(calls).toEqual([
      `acquire ${HC} /talk ${HC} /new`,
      `apply markGone ${HC} /talk; observe ${JSON.stringify({ ...route({ path: '/new', updatedAt: 8 }), domain: HC })}`,
      `release ${HC} /talk ${HC} /new`,
    ]);
  });

  // v1.41.1 review: one answer, one view change (every listing re-projects once)
  it('a migration and a transfer change the store’s view once each', async () => {
    const changes = vi.fn<() => void>();
    store.subscribe(changes);
    const version = store.getSnapshot().version;
    routes.migrate.mockResolvedValueOnce(route({ path: '/new', updatedAt: 8 }));
    await run(migrateRouteMutationOptions(client, store), {
      oldPath: '/talk',
      newPath: '/new',
      domain: HC,
      expectedUpdatedAt: 5,
    });
    expect(store.getSnapshot().version).toBe(version + 1);
    expect(changes).toHaveBeenCalledTimes(1);
    routes.transfer.mockResolvedValueOnce(route({ path: '/new', updatedAt: 9 }));
    await run(transferRouteMutationOptions(client, store), {
      path: '/new',
      fromDomain: HC,
      toDomain: LINK,
    });
    expect(store.getSnapshot().version).toBe(version + 2);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({ state: 'gone' });
    expect(store.answerAt(keyOfStored(HC, '/new'))).toEqual({ state: 'gone' });
    expect(store.answerAt(keyOfStored(LINK, '/new'))?.state).toBe('live');
  });

  it('a transfer marks the source gone and observes the route on its new domain', async () => {
    routes.transfer.mockResolvedValueOnce(route());
    await run(transferRouteMutationOptions(client, store), {
      path: '/talk',
      fromDomain: LINK,
      toDomain: HC,
    });
    expect(calls).toEqual([
      `acquire ${LINK} /talk ${HC} /talk`,
      `apply markGone ${LINK} /talk; observe ${JSON.stringify({ ...route(), domain: HC })}`,
      `release ${LINK} /talk ${HC} /talk`,
    ]);
  });

  it('the route is held for the whole flight, and only then', async () => {
    let answer!: (saved: Route) => void;
    routes.update.mockReturnValueOnce(
      new Promise<Route>(resolve => {
        answer = resolve;
      }),
    );
    const flight = run(updateRouteMutationOptions(client, store), {
      path: '/talk',
      data: {},
      domain: HC,
    });
    await vi.waitFor(() => expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(true));
    answer(route({ updatedAt: 6 }));
    await flight;
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
  });
});

/** An answer still in flight, and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settleWith => {
    resolve = settleWith;
  });
  return { promise, resolve };
}

describe('one write at a time per route, across every route a write affects', () => {
  // v1.41.1 review: the Worker normalises a write's path into its key, so
  // `/Promo/` is the same route as `/promo`
  it('a create at another spelling of a route whose delete is in flight is refused', async () => {
    const removal = deferred<undefined>();
    routes.delete.mockReturnValueOnce(removal.promise);
    const deleting = run(deleteRouteMutationOptions(client, store), { path: '/promo', domain: HC });
    await vi.waitFor(() => expect(store.isPending(keyOfInput(HC, '/promo'))).toBe(true));
    await expect(
      run(createRouteMutationOptions(client, store), {
        data: { path: '/Promo/', type: 'redirect', target: 'https://example.com/' },
        domain: HC,
      }),
    ).rejects.toBeInstanceOf(RouteWritePendingError);
    expect(routes.create).not.toHaveBeenCalled();
    removal.resolve(undefined);
    await deleting;
    // The delete's answer hides the listed row whichever spelling it used
    expect(store.project(list([route({ path: '/promo' })]), HC).routes).toEqual([]);
  });

  it('a migration to `/new/` while `/new` is held is refused, holding neither path', async () => {
    const toggle = deferred<Route>();
    routes.update.mockReturnValueOnce(toggle.promise);
    const toggling = run(toggleRouteMutationOptions(client, store), {
      path: '/new',
      enabled: false,
      domain: HC,
    });
    await vi.waitFor(() => expect(store.isPending(keyOfInput(HC, '/new'))).toBe(true));
    await expect(
      run(migrateRouteMutationOptions(client, store), {
        oldPath: '/talk',
        newPath: '/new/',
        domain: HC,
        expectedUpdatedAt: 5,
      }),
    ).rejects.toBeInstanceOf(RouteWritePendingError);
    expect(routes.migrate).not.toHaveBeenCalled();
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
    toggle.resolve(route({ path: '/new', enabled: false, updatedAt: 6 }));
    await toggling;
  });

  it('a recovery delete holds the exact key, apart from the normalised route', async () => {
    const recovery = deferred<undefined>();
    routes.delete.mockReturnValueOnce(recovery.promise);
    const recovering = run(deleteRouteMutationOptions(client, store), {
      path: '/Promo',
      domain: HC,
      recoverInvalid: true,
    });
    await vi.waitFor(() => expect(store.isPending(keyOfStored(HC, '/Promo'))).toBe(true));
    expect(store.isPending(keyOfInput(HC, '/promo'))).toBe(false);
    recovery.resolve(undefined);
    await recovering;
  });

  it('a create at a route whose delete is still in flight is refused, with no request', async () => {
    const removal = deferred<undefined>();
    routes.delete.mockReturnValueOnce(removal.promise);
    const deleting = run(deleteRouteMutationOptions(client, store), { path: '/talk', domain: HC });
    await vi.waitFor(() => expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(true));
    const refused = run(createRouteMutationOptions(client, store), {
      data: { path: '/talk', type: 'redirect', target: 'https://example.com/' },
      domain: HC,
    });
    await expect(refused).rejects.toBeInstanceOf(RouteWritePendingError);
    await expect(refused).rejects.toThrow('Another change to this route is still saving');
    expect(routes.create).not.toHaveBeenCalled();
    // The refusal released nothing: the delete still holds its route
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(true);
    removal.resolve(undefined);
    await deleting;
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
    expect(calls).toEqual([
      `acquire ${HC} /talk`,
      `refused ${HC} /talk`,
      `markGone ${HC} /talk`,
      `release ${HC} /talk`,
    ]);
    // Once it settled, the create is admitted
    routes.create.mockResolvedValueOnce(route());
    await run(createRouteMutationOptions(client, store), {
      data: { path: '/talk', type: 'redirect', target: 'https://example.com/' },
      domain: HC,
    });
    expect(routes.create).toHaveBeenCalledTimes(1);
  });

  it('a migration into a route with a write in flight is refused, holding neither path', async () => {
    const toggle = deferred<Route>();
    routes.update.mockReturnValueOnce(toggle.promise);
    const toggling = run(toggleRouteMutationOptions(client, store), {
      path: '/new',
      enabled: false,
      domain: HC,
    });
    await vi.waitFor(() => expect(store.isPending(keyOfInput(HC, '/new'))).toBe(true));
    await expect(
      run(migrateRouteMutationOptions(client, store), {
        oldPath: '/talk',
        newPath: '/new',
        domain: HC,
        expectedUpdatedAt: 5,
      }),
    ).rejects.toBeInstanceOf(RouteWritePendingError);
    expect(routes.migrate).not.toHaveBeenCalled();
    expect(store.isPending(keyOfInput(HC, '/talk'))).toBe(false);
    // A transfer onto it from another domain is refused too
    await expect(
      run(transferRouteMutationOptions(client, store), {
        path: '/new',
        fromDomain: LINK,
        toDomain: HC,
      }),
    ).rejects.toBeInstanceOf(RouteWritePendingError);
    expect(routes.transfer).not.toHaveBeenCalled();
    expect(store.isPending(keyOfInput(LINK, '/new'))).toBe(false);
    toggle.resolve(route({ path: '/new', enabled: false, updatedAt: 6 }));
    await toggling;
    expect(store.isPending(keyOfInput(HC, '/new'))).toBe(false);
  });
});

/** The Worker's 409 for a route changed since it was loaded. */
const changed = () =>
  new ApiError(409, 'This route changed while it was being edited', undefined, {
    code: 'ROUTE_SOURCE_CHANGED',
  });

/** The Worker's 404 for a route write: a bare text, no code. */
const notFound = () => new ApiError(404, 'Route not found: /talk');

describe('a failed write', () => {
  it('409 ROUTE_SOURCE_CHANGED forgets the refused version and refetches (update and migration)', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    routes.update.mockRejectedValueOnce(changed());
    await expect(
      run(updateRouteMutationOptions(client, store), {
        path: '/talk',
        data: {},
        domain: HC,
        expectedUpdatedAt: 5,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    routes.migrate.mockRejectedValueOnce(changed());
    await expect(
      run(migrateRouteMutationOptions(client, store), {
        oldPath: '/talk',
        newPath: '/new',
        domain: HC,
        expectedUpdatedAt: 5,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([
      `acquire ${HC} /talk`,
      `forget ${HC} /talk 5`,
      `release ${HC} /talk`,
      `acquire ${HC} /talk ${HC} /new`,
      `forget ${HC} /talk 5`,
      `release ${HC} /talk ${HC} /new`,
    ]);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  // Storage's "View in Routes" opened the editor on an older copy (5) than
  // this session's own answer (6): the 409 refuses that copy, not the answer
  it('a 409 to an editor opened on an older copy keeps this session’s answer', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    store.observe({ ...route({ enabled: false, updatedAt: 6 }), domain: HC });
    routes.update.mockRejectedValueOnce(changed());
    await expect(
      run(updateRouteMutationOptions(client, store), {
        path: '/talk',
        data: { preserveQuery: false },
        domain: HC,
        expectedUpdatedAt: 5,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: routeKeys.all });
    expect(store.project(list([route({ updatedAt: 9 })]), HC).routes).toEqual([
      route({ enabled: false, updatedAt: 6 }),
    ]);
    // Refusing the answer's own version forgets it: the server's row shows
    routes.update.mockRejectedValueOnce(changed());
    await expect(
      run(updateRouteMutationOptions(client, store), {
        path: '/talk',
        data: { preserveQuery: false },
        domain: HC,
        expectedUpdatedAt: 6,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(store.project(list([route({ updatedAt: 9 })]), HC).routes).toEqual([
      route({ updatedAt: 9 }),
    ]);
  });

  it('a 404 refetches and never marks the route gone', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    routes.update.mockRejectedValueOnce(notFound());
    await expect(
      run(toggleRouteMutationOptions(client, store), { path: '/talk', enabled: false, domain: HC }),
    ).rejects.toBeInstanceOf(ApiError);
    routes.delete.mockRejectedValueOnce(notFound());
    await expect(
      run(deleteRouteMutationOptions(client, store), {
        path: '/Talk',
        domain: HC,
        recoverInvalid: true,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    routes.transfer.mockRejectedValueOnce(notFound());
    await expect(
      run(transferRouteMutationOptions(client, store), {
        path: '/talk',
        fromDomain: LINK,
        toDomain: HC,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    // A missing route and an unknown endpoint answer alike (a 404)
    expect(
      calls.filter(call => !call.startsWith('acquire') && !call.startsWith('release')),
    ).toEqual([]);
    expect(store.size()).toBe(0);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('any other refusal (a definite 4xx answer) leaves the store alone', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    store.observe({ ...route({ updatedAt: 6 }), domain: HC });
    calls.length = 0;
    routes.update.mockRejectedValueOnce(new ApiError(422, 'Unprocessable'));
    await expect(
      run(updateRouteMutationOptions(client, store), { path: '/talk', data: {}, domain: HC }),
    ).rejects.toBeInstanceOf(ApiError);
    routes.delete.mockRejectedValueOnce(new ApiError(400, 'Validation failed'));
    await expect(
      run(deleteRouteMutationOptions(client, store), { path: '/talk', domain: HC }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([
      `acquire ${HC} /talk`,
      `release ${HC} /talk`,
      `acquire ${HC} /talk`,
      `release ${HC} /talk`,
    ]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(store.answerAt(keyOfStored(HC, '/talk'))?.state).toBe('live');
  });

  // v1.41.1 review: no definite answer (a 5xx, no answer, an unreadable
  // body) leaves unknown whether the write landed
  it('a delete marks the key gone; a re-create answered 502 drops the entry and refetches', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    routes.delete.mockResolvedValueOnce(undefined);
    await run(deleteRouteMutationOptions(client, store), { path: '/talk', domain: HC });
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({ state: 'gone' });
    invalidate.mockClear();
    calls.length = 0;
    routes.create.mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'));
    await expect(
      run(createRouteMutationOptions(client, store), {
        data: { path: '/talk', type: 'redirect', target: 'https://example.com/' },
        domain: HC,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([`acquire ${HC} /talk`, `dropHeld ${HC} /talk`, `release ${HC} /talk`]);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toBeUndefined();
    // The server's rows show again: the stale listed row is not hidden
    expect(store.project(list([route()]), HC).routes).toEqual([route()]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: routeKeys.all });
  });

  it('no answer, or an unreadable body, drops every route the write held', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    store.observe({ ...route({ updatedAt: 6 }), domain: HC });
    store.markGone(keyOfInput(HC, '/new'));
    calls.length = 0;
    routes.migrate.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(
      run(migrateRouteMutationOptions(client, store), {
        oldPath: '/talk',
        newPath: '/new',
        domain: HC,
        expectedUpdatedAt: 6,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(store.size()).toBe(0);
    store.observe({ ...route({ updatedAt: 7 }), domain: HC });
    routes.update.mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'));
    await expect(
      run(toggleRouteMutationOptions(client, store), { path: '/talk', enabled: false, domain: HC }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(store.size()).toBe(0);
    expect(calls.filter(call => call.startsWith('dropHeld'))).toEqual([
      `dropHeld ${HC} /talk ${HC} /new`,
      `dropHeld ${HC} /talk`,
    ]);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('a write refused before any request leaves the store untouched', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    store.markGone(keyOfInput(HC, '/talk'));
    const held = store.acquire([keyOfInput(HC, '/talk')])!;
    calls.length = 0;
    await expect(
      run(createRouteMutationOptions(client, store), {
        data: { path: '/talk', type: 'redirect', target: 'https://example.com/' },
        domain: HC,
      }),
    ).rejects.toBeInstanceOf(RouteWritePendingError);
    expect(calls).toEqual([`refused ${HC} /talk`]);
    expect(store.answerAt(keyOfStored(HC, '/talk'))).toEqual({ state: 'gone' });
    expect(invalidate).not.toHaveBeenCalled();
    store.release(held);
  });

  // v1.41.1 review: a toggle sends no precondition, so a 409 to it names no
  // refused version, and never forgets an entry (even one with no updatedAt)
  it('a 409 to a toggle refetches and forgets nothing', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    store.observe({ ...route({ updatedAt: undefined }), domain: HC });
    calls.length = 0;
    routes.update.mockRejectedValueOnce(changed());
    await expect(
      run(toggleRouteMutationOptions(client, store), { path: '/talk', enabled: false, domain: HC }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(routes.update).toHaveBeenCalledWith('/talk', { enabled: false }, HC, undefined);
    expect(calls).toEqual([`acquire ${HC} /talk`, `release ${HC} /talk`]);
    expect(store.answerAt(keyOfStored(HC, '/talk'))?.state).toBe('live');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: routeKeys.all });
  });
});

describe('the route queries show their cached listing through the store', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    pendingRoutes.clear();
    // A refetch never lands: what shows is the cached raw listing, projected
    routes.list.mockReturnValue(new Promise(() => undefined));
    routes.byTarget.mockReturnValue(new Promise(() => undefined));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    pendingRoutes.clear();
    vi.unstubAllGlobals();
  });

  async function renderHook<T>(use: () => T): Promise<{ current: T }> {
    const result = {} as { current: T };
    function Probe() {
      result.current = use();
      return null;
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
    return result;
  }

  it('a domain list, a search and a by-target answer show an own write at once', async () => {
    const stale = route({ type: 'r2', target: 'a.pdf', updatedAt: 5 });
    client.setQueryData(routeKeys.list(HC), list([stale]));
    client.setQueryData(routeKeys.search('talk'), list([{ ...stale, domain: HC }]));
    client.setQueryData(routeKeys.byTarget('files', 'a.pdf'), [{ ...stale, domain: HC }]);
    const listed = await renderHook(() => ({
      page: useRoutes(HC).data?.routes,
      search: useSearchRoutes('talk').data?.routes,
      byTarget: useRoutesByTarget('files', 'a.pdf').data,
    }));
    expect(listed.current.page).toEqual([stale]);

    const saved = { ...route({ type: 'r2', target: 'a.pdf', updatedAt: 3 }), domain: HC };
    await act(async () => pendingRoutes.observe(saved));
    expect(listed.current.page).toEqual([route({ type: 'r2', target: 'a.pdf', updatedAt: 3 })]);
    expect(listed.current.search).toEqual([saved]);
    expect(listed.current.byTarget).toEqual([saved]);
    // The cache itself still holds the server's rows
    expect(client.getQueryData<ReturnType<typeof list>>(routeKeys.list(HC))?.routes).toEqual([
      stale,
    ]);

    // Re-pointed at another object: it leaves that object's answer only
    await act(async () => pendingRoutes.observe({ ...saved, target: 'b.pdf' }));
    expect(listed.current.byTarget).toEqual([]);
    expect(listed.current.page).toEqual([route({ type: 'r2', target: 'b.pdf', updatedAt: 3 })]);

    await act(async () => pendingRoutes.markGone(keyOfInput(HC, '/talk')));
    expect(listed.current.page).toEqual([]);
    expect(listed.current.search).toEqual([]);
  });

  it('the write hooks install the options: a toggle through the hook lands in the dashboard store', async () => {
    client.setQueryData(routeKeys.list(HC), list([route()]));
    routes.update.mockResolvedValueOnce(route({ enabled: false, updatedAt: 6 }));
    const hooks = await renderHook(() => ({
      page: useRoutes(HC).data?.routes,
      create: useCreateRoute(),
      update: useUpdateRoute(),
      remove: useDeleteRoute(),
      toggle: useToggleRoute(),
      migrate: useMigrateRoute(),
      transfer: useTransferRoute(),
    }));
    for (const write of ['create', 'update', 'remove', 'migrate', 'transfer'] as const) {
      expect(hooks.current[write].isIdle).toBe(true);
    }
    await act(async () => {
      await hooks.current.toggle.mutateAsync({ path: '/talk', enabled: false, domain: HC });
    });
    expect(routes.update).toHaveBeenCalledWith('/talk', { enabled: false }, HC, undefined);
    expect(hooks.current.page).toEqual([route({ enabled: false, updatedAt: 6 })]);
    expect(pendingRoutes.isPending(keyOfInput(HC, '/talk'))).toBe(false);
  });

  it('a search listing drops a saved answer its search no longer matches', async () => {
    // The domain counts in the all-domains search only, as on the Worker
    const onSite = route({ target: 'https://example.com/talk' });
    client.setQueryData(routeKeys.list(HC, 'example'), list([onSite]));
    client.setQueryData(routeKeys.search('example'), list([{ ...onSite, domain: HC }]));
    client.setQueryData(routeKeys.list(HC), list([onSite]));
    const listed = await renderHook(() => ({
      page: useRoutes(HC, { search: 'example' }).data?.routes,
      search: useSearchRoutes('example').data?.routes,
      unfiltered: useRoutes(HC).data?.routes,
    }));
    const moved = { ...route({ target: 'https://moved.test/', updatedAt: 6 }), domain: HC };
    await act(async () => pendingRoutes.observe(moved));
    expect(listed.current.page).toEqual([]);
    // Still matched there by its domain
    expect(listed.current.search).toEqual([moved]);
    expect(listed.current.unfiltered).toEqual([
      route({ target: 'https://moved.test/', updatedAt: 6 }),
    ]);
  });

  // v1.41.1 review: `select` re-runs on every store change; the matcher it
  // closes over is built once per search and domain
  it('a search listing parses its search once, however often the store changes', async () => {
    client.setQueryData(routeKeys.list(HC, 'example'), list([route()]));
    client.setQueryData(routeKeys.search('example'), list([{ ...route(), domain: HC }]));
    const listed = await renderHook(() => ({
      page: useRoutes(HC, { search: 'example' }).data?.routes,
      search: useSearchRoutes('example').data?.routes,
    }));
    const parse = vi.mocked(parseSearchQuery);
    parse.mockClear();
    for (const updatedAt of [6, 7, 8]) {
      await act(async () =>
        pendingRoutes.observe({
          ...route({ target: 'https://example.com/x', updatedAt }),
          domain: HC,
        }),
      );
    }
    expect(listed.current.page).toEqual([route({ target: 'https://example.com/x', updatedAt: 8 })]);
    expect(parse).not.toHaveBeenCalled();
  });

  // v1.41.1 review: the answer keeps showing until the refetch has landed,
  // then the listing shows the refetch's result
  it('an expired answer refetches the active route queries once, and shows until the refetch lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const remove = vi.spyOn(client, 'removeQueries');
      // The mount's own fetches land before the write
      routes.list.mockResolvedValue(list([route()]));
      client.setQueryData(routeKeys.list(HC), list([route()]));
      const listed = await renderHook(() => ({
        page: useRoutes(HC).data?.routes,
        search: useSearchRoutes('talk').data?.routes,
      }));
      await vi.waitFor(() => expect(listed.current.search).toEqual([route()]));
      const refetched = deferred<ReturnType<typeof list>>();
      routes.list.mockReturnValue(refetched.promise);
      await act(async () => pendingRoutes.observe({ ...route({ updatedAt: 6 }), domain: HC }));
      expect(invalidate).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PENDING_ROUTE_TTL_MS + 1);
      });
      expect(remove).toHaveBeenCalledWith({ queryKey: routeKeys.all, type: 'inactive' });
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: routeKeys.all, refetchType: 'active' });
      // The refetch is in flight: the answer still shows
      expect(listed.current.page).toEqual([route({ updatedAt: 6 })]);
      expect(pendingRoutes.size()).toBe(1);
      await act(async () => {
        refetched.resolve(list([route({ updatedAt: 9 })]));
        await vi.advanceTimersByTimeAsync(10);
      });
      await vi.waitFor(() => expect(listed.current.page).toEqual([route({ updatedAt: 9 })]));
      expect(pendingRoutes.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // v1.41.1 review: TanStack Query hands a pending mutation each newer
  // render's options, so `onSuccess` runs from options other than the ones
  // that sent it; whether the create read its route back travels in the result
  it('a create re-rendered while in flight still never lets a read back overwrite an own entry', async () => {
    const own = { ...route({ enabled: false, updatedAt: 9 }), domain: HC };
    await act(async () => pendingRoutes.observe(own));
    routes.create.mockRejectedValueOnce(new ApiError(409, 'Route already exists: /talk'));
    const readBack = deferred<Route>();
    routes.get.mockReturnValueOnce(readBack.promise);
    // One component that re-renders in place (the same mutation observer)
    let rerender!: () => void;
    let renders = 0;
    const hooks = await renderHook(() => {
      const [, setTick] = useState(0);
      rerender = () => setTick(tick => tick + 1);
      renders += 1;
      return useCreateRoute();
    });
    let created!: Promise<unknown>;
    await act(async () => {
      created = hooks.current.mutateAsync({
        data: { path: '/talk', type: 'redirect', target: 'https://example.com/' },
        domain: HC,
        afterUncertainAnswer: true,
      });
    });
    await vi.waitFor(() => expect(routes.get).toHaveBeenCalledTimes(1));
    // A re-render with the mutation pending: TanStack Query hands the pending
    // mutation the new render's options, whose `onSuccess` settles it
    const before = renders;
    await act(async () => rerender());
    expect(renders).toBeGreaterThan(before);
    await act(async () => {
      readBack.resolve(route({ updatedAt: 5 }));
      await created;
    });
    await expect(created).resolves.toEqual({ route: route({ updatedAt: 5 }), readBack: true });
    expect(pendingRoutes.answerAt(keyOfStored(HC, '/talk'))).toEqual({ state: 'live', route: own });
  });
});

/** Render `use` in `target`, under the test's query client; its latest result. */
async function mount<T>(target: Root, use: () => T): Promise<{ current: T }> {
  const result = {} as { current: T };
  function Probe() {
    result.current = use();
    return null;
  }
  await act(async () =>
    target.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  return result;
}

/** Run the fake clock past the TTL: the store's expiry fires. */
const expire = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(PENDING_ROUTE_TTL_MS + 1);
  });

/** The route query in the cache at exactly `queryKey`, if any. */
const cached = (queryKey: readonly unknown[]) =>
  client.getQueryCache().find({ queryKey, exact: true });

/** The panels opened and closed around the write: a search and Storage's by-target answer. */
const panels = () => ({
  search: useSearchRoutes('talk').data?.routes,
  byTarget: useRoutesByTarget('files', 'a.pdf').data,
});

describe('expiry touches only what is on screen (v1.41.1 review)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let panelContainer: HTMLDivElement;
  let panel: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    pendingRoutes.clear();
    container = document.createElement('div');
    panelContainer = document.createElement('div');
    document.body.append(container, panelContainer);
    root = createRoot(container);
    panel = createRoot(panelContainer);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      panel.unmount();
    });
    container.remove();
    panelContainer.remove();
    pendingRoutes.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Open the panels, let their fetches land, and close them again. */
  async function openAndClosePanels(): Promise<void> {
    const opened = await mount(panel, panels);
    await vi.waitFor(() => {
      expect(opened.current.search).toBeDefined();
      expect(opened.current.byTarget).toBeDefined();
    });
    await act(async () => panel.unmount());
    panel = createRoot(panelContainer);
  }

  // Storage's "Associated Routes" and the command palette's search were
  // closed before the write: their raw caches still hold the pre-write row
  it('an unwatched search and by-target answer are removed, and load fresh when reopened', async () => {
    const stale = route({ type: 'r2', target: 'a.pdf', updatedAt: 5 });
    const fresh = route({ type: 'r2', target: 'a.pdf', enabled: false, updatedAt: 7 });
    const saved = { ...fresh, domain: HC };
    routes.list.mockImplementation(async (domain: unknown) =>
      domain === HC ? list([stale]) : list([{ ...stale, domain: HC }]),
    );
    routes.byTarget.mockResolvedValue([{ ...stale, domain: HC }]);
    const page = await mount(root, () => useRoutes(HC).data?.routes);
    await vi.waitFor(() => expect(page.current).toEqual([stale]));
    await openAndClosePanels();

    await act(async () => pendingRoutes.observe(saved));
    routes.list.mockClear();
    routes.byTarget.mockClear();
    routes.list.mockResolvedValue(list([fresh]));
    await expire();
    await vi.waitFor(() => expect(pendingRoutes.size()).toBe(0));
    // Only the page was refetched; the closed panels were removed, not refetched
    expect(routes.list).toHaveBeenCalledTimes(1);
    expect(routes.list).toHaveBeenCalledWith(HC, undefined);
    expect(routes.byTarget).not.toHaveBeenCalled();
    expect(cached(routeKeys.search('talk'))).toBeUndefined();
    expect(cached(routeKeys.byTarget('files', 'a.pdf'))).toBeUndefined();
    expect(page.current).toEqual([fresh]);

    // Reopened: loading, then the fresh rows, never the pre-write raw ones
    const listed = deferred<ReturnType<typeof list>>();
    const answered = deferred<Array<Route & { domain: string }>>();
    routes.list.mockReturnValue(listed.promise);
    routes.byTarget.mockReturnValue(answered.promise);
    const reopened = await mount(panel, panels);
    expect(reopened.current).toEqual({ search: undefined, byTarget: undefined });
    await act(async () => {
      listed.resolve(list([saved]));
      answered.resolve([saved]);
      await vi.advanceTimersByTimeAsync(10);
    });
    await vi.waitFor(() =>
      expect(reopened.current).toEqual({ search: [saved], byTarget: [saved] }),
    );
  });

  it('an unwatched query whose fetch would fail never blocks the expiry', async () => {
    routes.list.mockResolvedValue(list([route()]));
    routes.byTarget.mockResolvedValue([{ ...route(), domain: HC }]);
    const page = await mount(root, () => useRoutes(HC).data?.routes);
    await vi.waitFor(() => expect(page.current).toEqual([route()]));
    await openAndClosePanels();
    await act(async () => pendingRoutes.observe({ ...route({ updatedAt: 6 }), domain: HC }));
    // The search and by-target would fail now; the page's refetch lands
    routes.list.mockImplementation(async (domain: unknown) => {
      if (domain !== HC) throw new TypeError('Failed to fetch');
      return list([route({ updatedAt: 6 })]);
    });
    routes.byTarget.mockRejectedValue(new ApiError(500, 'Internal error'));
    await expire();
    await vi.waitFor(() => expect(pendingRoutes.size()).toBe(0));
    expect(routes.byTarget).toHaveBeenCalledTimes(1);
    expect(page.current).toEqual([route({ updatedAt: 6 })]);
  });

  it('a watched by-target answer whose refetch fails keeps the batch until it lands', async () => {
    routes.list.mockResolvedValue(list([route()]));
    routes.byTarget.mockResolvedValue([{ ...route(), domain: HC }]);
    const page = await mount(root, () => useRoutes(HC).data?.routes);
    const open = await mount(panel, panels);
    await vi.waitFor(() => expect(open.current.byTarget).toEqual([{ ...route(), domain: HC }]));
    await vi.waitFor(() => expect(page.current).toEqual([route()]));
    await act(async () => pendingRoutes.observe({ ...route({ updatedAt: 6 }), domain: HC }));
    routes.list.mockResolvedValue(list([route({ updatedAt: 6 })]));
    routes.byTarget.mockRejectedValue(new ApiError(500, 'Internal error'));
    await expire();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(routes.byTarget).toHaveBeenCalledTimes(2);
    expect(pendingRoutes.size()).toBe(1);
    routes.byTarget.mockResolvedValue([{ ...route({ updatedAt: 6 }), domain: HC }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_ROUTE_EXPIRY_RETRY_MS + 10);
    });
    await vi.waitFor(() => expect(pendingRoutes.size()).toBe(0));
    expect(open.current.byTarget).toEqual([{ ...route({ updatedAt: 6 }), domain: HC }]);
  });

  // The page's first load was sent before the write landed in KV: its
  // answer, landing after the expiry began, is not a refresh
  it('a first load in flight at expiry keeps the batch; the retry’s own fetch drops it', async () => {
    const firstLoad = deferred<ReturnType<typeof list>>();
    routes.list.mockReturnValue(firstLoad.promise);
    const page = await mount(root, () => useRoutes(HC).data?.routes);
    await act(async () => pendingRoutes.observe({ ...route({ updatedAt: 6 }), domain: HC }));
    await expire();
    // The refetch reuses the first load's promise: no second request
    expect(routes.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstLoad.resolve(list([route()]));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(pendingRoutes.size()).toBe(1);
    expect(page.current).toEqual([route({ updatedAt: 6 })]);
    routes.list.mockResolvedValue(list([route({ updatedAt: 6 })]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_ROUTE_EXPIRY_RETRY_MS + 10);
    });
    expect(routes.list).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(pendingRoutes.size()).toBe(0));
    expect(page.current).toEqual([route({ updatedAt: 6 })]);
  });

  // A query holding data whose refetch is in flight is cancelled and fetched
  // again (TanStack Query's cancelRefetch): counted conservatively, retried
  it('a refetch in flight at expiry counts as not refreshed; the retry drops the batch', async () => {
    routes.list.mockResolvedValue(list([route()]));
    const page = await mount(root, () => useRoutes(HC).data?.routes);
    await vi.waitFor(() => expect(page.current).toEqual([route()]));
    await act(async () => pendingRoutes.observe({ ...route({ updatedAt: 6 }), domain: HC }));
    // Another write's refetch is still in flight when the expiry begins
    const inFlight = deferred<ReturnType<typeof list>>();
    routes.list.mockReturnValueOnce(inFlight.promise);
    await act(async () => {
      void client.refetchQueries({ queryKey: routeKeys.list(HC) });
    });
    routes.list.mockResolvedValue(list([route({ updatedAt: 6 })]));
    await expire();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(pendingRoutes.size()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_ROUTE_EXPIRY_RETRY_MS + 10);
    });
    await vi.waitFor(() => expect(pendingRoutes.size()).toBe(0));
    expect(page.current).toEqual([route({ updatedAt: 6 })]);
  });

  it('the network down at expiry keeps a watched entry, retries it, and drops it after a refetch that lands', async () => {
    // The page's own first fetch answers the pre-write row
    routes.list.mockResolvedValue(list([route()]));
    const page = await mount(root, () => useRoutes(HC).data?.routes);
    await vi.waitFor(() => expect(page.current).toEqual([route()]));
    await act(async () => pendingRoutes.observe({ ...route({ updatedAt: 6 }), domain: HC }));
    routes.list.mockClear();
    routes.list.mockRejectedValue(new TypeError('Failed to fetch'));
    await expire();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(routes.list).toHaveBeenCalledTimes(1);
    // The refetch failed: the raw listing is the pre-write one, so the
    // answer stays
    expect(pendingRoutes.size()).toBe(1);
    expect(page.current).toEqual([route({ updatedAt: 6 })]);
    // The retry fails as well
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_ROUTE_EXPIRY_RETRY_MS + 10);
    });
    expect(routes.list).toHaveBeenCalledTimes(2);
    expect(pendingRoutes.size()).toBe(1);
    // Back online: the next retry lands, and the batch drops
    routes.list.mockResolvedValue(list([route({ updatedAt: 6 })]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_ROUTE_EXPIRY_RETRY_MS + 10);
    });
    expect(routes.list).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(pendingRoutes.size()).toBe(0));
    expect(page.current).toEqual([route({ updatedAt: 6 })]);
  });
});
