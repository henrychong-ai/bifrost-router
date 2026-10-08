// @vitest-environment happy-dom

/**
 * The route hooks write their answers into the cached route listings
 * (v1.41.0): each hook is rendered against a
 * real QueryClient with the API client mocked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://api.example.test' },
}));
vi.mock('@/lib/api-client', () => ({
  api: {
    routes: {
      get: vi.fn<(...args: unknown[]) => unknown>(),
      update: vi.fn<(...args: unknown[]) => unknown>(),
      delete: vi.fn<(...args: unknown[]) => unknown>(),
      migrate: vi.fn<(...args: unknown[]) => unknown>(),
      transfer: vi.fn<(...args: unknown[]) => unknown>(),
    },
  },
}));

import { api } from '@/lib/api-client';
import type { Route } from '@/lib/schemas';
import {
  routeKeys,
  useDeleteRoute,
  useMigrateRoute,
  useToggleRoute,
  useTransferRoute,
  useUpdateRoute,
} from './use-routes';

const routes = vi.mocked(api.routes);
const DOMAIN = 'example.com';
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

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const mock of Object.values(routes)) mock.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Render `use` and hand back what it returned on the last render. */
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

function list(rows: Route[]) {
  return { routes: rows, invalidRoutes: [], total: rows.length, offset: 0, hasMore: false };
}

const listed = (domain: string) =>
  client.getQueryData<ReturnType<typeof list>>(routeKeys.list(domain))?.routes;

/** A promise and the function that settles it, for answers arriving out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('route hooks write their answers into the cached listings (v1.41.0)', () => {
  beforeEach(() => {
    client.setQueryData(routeKeys.list(DOMAIN), list([route()]));
    client.setQueryData(routeKeys.list(LINK), list([route()]));
  });

  it('an update and a toggle replace the row of that domain and path only', async () => {
    routes.update.mockResolvedValueOnce(route({ updatedAt: 6 }));
    const update = await renderHook(() => useUpdateRoute());
    await act(async () => {
      await update.current.mutateAsync({ path: '/talk', data: {}, domain: DOMAIN });
    });
    expect(listed(DOMAIN)).toEqual([route({ updatedAt: 6 })]);

    routes.update.mockResolvedValueOnce(route({ enabled: false, updatedAt: 7 }));
    const toggle = await renderHook(() => useToggleRoute());
    await act(async () => {
      await toggle.current.mutateAsync({ path: '/talk', enabled: false, domain: DOMAIN });
    });
    expect(listed(DOMAIN)).toEqual([route({ enabled: false, updatedAt: 7 })]);
    expect(listed(LINK)).toEqual([route()]);
  });

  it('two saves answered in reverse order (3000 before 2000): the row keeps 3000', async () => {
    const first = deferred<Route>();
    const second = deferred<Route>();
    routes.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const update = await renderHook(() => useUpdateRoute());
    let pending: Promise<unknown>[] = [];
    await act(async () => {
      pending = [
        update.current.mutateAsync({ path: '/talk', data: {}, domain: DOMAIN }),
        update.current.mutateAsync({ path: '/talk', data: {}, domain: DOMAIN }),
      ];
    });
    await act(async () => {
      second.resolve(route({ target: 'https://new.example/', updatedAt: 3000 }));
      await pending[1];
    });
    await act(async () => {
      first.resolve(route({ target: 'https://old.example/', updatedAt: 2000 }));
      await pending[0];
    });
    expect(listed(DOMAIN)).toEqual([route({ target: 'https://new.example/', updatedAt: 3000 })]);
  });

  it('a migration moves the row; a delete removes it; a transfer moves it to its new domain', async () => {
    routes.migrate.mockResolvedValueOnce(route({ path: '/new', updatedAt: 8 }));
    const migrate = await renderHook(() => useMigrateRoute());
    await act(async () => {
      await migrate.current.mutateAsync({ oldPath: '/talk', newPath: '/new', domain: DOMAIN });
    });
    expect(listed(DOMAIN)).toEqual([route({ path: '/new', updatedAt: 8 })]);

    routes.delete.mockResolvedValueOnce(undefined);
    const remove = await renderHook(() => useDeleteRoute());
    await act(async () => {
      await remove.current.mutateAsync({ path: '/new', domain: DOMAIN });
    });
    expect(listed(DOMAIN)).toEqual([]);

    routes.transfer.mockResolvedValueOnce(route());
    const transfer = await renderHook(() => useTransferRoute());
    await act(async () => {
      await transfer.current.mutateAsync({ path: '/talk', fromDomain: LINK, toDomain: DOMAIN });
    });
    expect(listed(LINK)).toEqual([]);
    // The destination's listings are left to the refetch (v1.41.0 review)
    expect(listed(DOMAIN)).toEqual([]);
  });

  // v1.41.0 review: no clock orders two writes. Both saves superseded 5; the
  // later one answers first (2000) and is applied; the earlier one, stamped
  // by a faster clock, answers last with a GREATER stamp (3000) and is not,
  // since the row is no longer the version it superseded
  it('two saves answered in reverse order, the late one stamped greater (2000, then 3000): the row keeps 2000', async () => {
    const first = deferred<Route>();
    const second = deferred<Route>();
    routes.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const update = await renderHook(() => useUpdateRoute());
    let pending: Promise<unknown>[] = [];
    await act(async () => {
      pending = [
        update.current.mutateAsync({
          path: '/talk',
          data: {},
          domain: DOMAIN,
          expectedUpdatedAt: 5,
        }),
        update.current.mutateAsync({
          path: '/talk',
          data: {},
          domain: DOMAIN,
          expectedUpdatedAt: 5,
        }),
      ];
    });
    await act(async () => {
      second.resolve(route({ target: 'https://later.example/', updatedAt: 2000 }));
      await pending[1];
    });
    await act(async () => {
      first.resolve(route({ target: 'https://earlier.example/', updatedAt: 3000 }));
      await pending[0];
    });
    expect(listed(DOMAIN)).toEqual([route({ target: 'https://later.example/', updatedAt: 2000 })]);
  });

  // v1.41.0 review: isolates' clocks disagree, so a later save can be stamped
  // EARLIER than the row it replaced. Each hook names the version its write
  // superseded (the expectedUpdatedAt an update sends, else the cached
  // version when it starts), and that row takes the answer
  it('a save or a toggle stamped by a clock that ran behind still replaces the version it superseded', async () => {
    routes.update.mockResolvedValueOnce(route({ target: 'https://b.example/', updatedAt: 3 }));
    const update = await renderHook(() => useUpdateRoute());
    await act(async () => {
      await update.current.mutateAsync({
        path: '/talk',
        data: {},
        domain: DOMAIN,
        expectedUpdatedAt: 5,
      });
    });
    expect(listed(DOMAIN)).toEqual([route({ target: 'https://b.example/', updatedAt: 3 })]);

    routes.update.mockResolvedValueOnce(route({ enabled: false, updatedAt: 2 }));
    const toggle = await renderHook(() => useToggleRoute());
    await act(async () => {
      await toggle.current.mutateAsync({ path: '/talk', enabled: false, domain: DOMAIN });
    });
    expect(listed(DOMAIN)).toEqual([route({ enabled: false, updatedAt: 2 })]);

    routes.migrate.mockResolvedValueOnce(route({ path: '/new', updatedAt: 1 }));
    const migrate = await renderHook(() => useMigrateRoute());
    await act(async () => {
      await migrate.current.mutateAsync({ oldPath: '/talk', newPath: '/new', domain: DOMAIN });
    });
    expect(listed(DOMAIN)).toEqual([route({ path: '/new', updatedAt: 1 })]);
  });

  // v1.41.0 review: the version removed is read when the mutation starts, so
  // a delete or transfer answered after the route was re-created at that path
  // and the listing refetched leaves the re-created row (and the total) alone,
  // whether a faster clock stamped it greater (9) or a slower one smaller (3)
  it.each([9, 3])(
    'a delete or a transfer answered after a re-create (stamped %i) and refetch keeps that row',
    async recreated => {
      const deleted = deferred<undefined>();
      routes.delete.mockReturnValueOnce(deleted.promise);
      const remove = await renderHook(() => useDeleteRoute());
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        pending = remove.current.mutateAsync({ path: '/talk', domain: DOMAIN });
      });
      client.setQueryData(routeKeys.list(DOMAIN), list([route({ updatedAt: recreated })]));
      await act(async () => {
        deleted.resolve(undefined);
        await pending;
      });
      expect(listed(DOMAIN)).toEqual([route({ updatedAt: recreated })]);
      expect(client.getQueryData<ReturnType<typeof list>>(routeKeys.list(DOMAIN))?.total).toBe(1);

      const moved = deferred<Route>();
      routes.transfer.mockReturnValueOnce(moved.promise);
      const transfer = await renderHook(() => useTransferRoute());
      await act(async () => {
        pending = transfer.current.mutateAsync({
          path: '/talk',
          fromDomain: LINK,
          toDomain: 'c.example.com',
        });
      });
      client.setQueryData(routeKeys.list(LINK), list([route({ updatedAt: recreated })]));
      await act(async () => {
        moved.resolve(route({ updatedAt: 6 }));
        await pending;
      });
      expect(listed(LINK)).toEqual([route({ updatedAt: recreated })]);
    },
  );

  it('a recovery delete removes the unreadable row by its exact key, not a route', async () => {
    client.setQueryData(routeKeys.list(DOMAIN), {
      ...list([route()]),
      invalidRoutes: [{ domain: DOMAIN, path: '/Talk', invalid: true as const }],
      total: 2,
    });
    routes.delete.mockResolvedValueOnce(undefined);
    const remove = await renderHook(() => useDeleteRoute());
    await act(async () => {
      await remove.current.mutateAsync({ path: '/Talk', domain: DOMAIN, recoverInvalid: true });
    });
    expect(routes.delete).toHaveBeenCalledWith('/Talk', DOMAIN, { recoverInvalid: true });
    const listing = client.getQueryData<ReturnType<typeof list>>(routeKeys.list(DOMAIN));
    expect(listing?.invalidRoutes).toEqual([]);
    expect(listing?.routes).toEqual([route()]);
    expect(listing?.total).toBe(1);
  });
});
