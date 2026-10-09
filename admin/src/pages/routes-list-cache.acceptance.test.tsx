// @vitest-environment happy-dom

/**
 * Reading the listed row after a write, before and after a stale refetch
 * (v1.41.1). Every write's answer is held in the pending-route store
 * (`admin/src/lib/route-pending.ts`) and shown in every read of every listing
 * (the real `useRoutes` select), so everything that reads the row (the
 * toggle's label and value, the Active/Disabled badge, the status filter, the
 * editor and the `expectedUpdatedAt` it sends) agrees before the refetch
 * lands, and after a refetch that still lags. One write at a time per route:
 * a route with a write in flight has its write actions disabled, and a write
 * there is refused before any request. A dialog opened before an own write
 * answered at its route sends nothing. v1.41.0 patched the cached listings
 * instead (`applyRouteSaved`), by version identity.
 *
 * The page runs the real route hooks (their real options, so acquire/release
 * and the store run as in the app) with each request replaced by a `state`
 * mock that receives the mutation's variables, and every list fetch answers
 * the server's (stale) rows, `state.routes`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UseRoutesModule from '@/hooks/use-routes';
import type * as ApiClientModule from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';
import type { Route } from '@/lib/schemas';

const state = vi.hoisted(() => ({
  routes: [] as Route[],
  /** The server's unreadable records, listed beside `routes` */
  invalid: [] as Array<{ domain: string; path: string; invalid: true }>,
  filters: {} as Record<string, unknown>,
  /** What the route listing answers, every time: the first fetch and each refetch */
  list: vi.fn<(...args: unknown[]) => unknown>(),
  byTarget: vi.fn<(...args: unknown[]) => unknown>(),
  create: vi.fn<(...args: unknown[]) => unknown>(),
  update: vi.fn<(...args: unknown[]) => unknown>(),
  migrate: vi.fn<(...args: unknown[]) => unknown>(),
  remove: vi.fn<(...args: unknown[]) => unknown>(),
  toggle: vi.fn<(...args: unknown[]) => unknown>(),
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
}));

const { idle } = vi.hoisted(() => ({
  idle: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
}));

// The API client the real route hooks call: listings answer `state.list`
vi.mock('@/lib/api-client', async importOriginal => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  api: { routes: { list: state.list, byTarget: state.byTarget } },
}));

vi.mock('@/hooks', async () => {
  const { useMutation, useQueryClient } = await import('@tanstack/react-query');
  const hooks = await vi.importActual<typeof UseRoutesModule>('@/hooks/use-routes');
  /**
   * A route write as the app installs it (its real options, so
   * acquire/release and the pending-route store run as they do in the app),
   * with the request replaced by a `state` mock that receives the mutation's
   * variables.
   */
  const write =
    (
      options: (client: ReturnType<typeof useQueryClient>) => object,
      request: typeof state.update,
    ) =>
    () =>
      useMutation({
        ...options(useQueryClient()),
        mutationFn: (variables: unknown) => request(variables),
      } as Parameters<typeof useMutation>[0]);
  return {
    routeKeys: hooks.routeKeys,
    // The real list query: its cache holds `state.list`'s raw answer and the
    // page reads it through the pending-route store
    useRoutes: hooks.useRoutes,
    usePendingRouteView: hooks.usePendingRouteView,
    usePendingRouteAdmission: hooks.usePendingRouteAdmission,
    useCreateRoute: write(hooks.createRouteMutationOptions, state.create),
    useUpdateRoute: write(hooks.updateRouteMutationOptions, state.update),
    useDeleteRoute: write(hooks.deleteRouteMutationOptions, state.remove),
    useToggleRoute: write(hooks.toggleRouteMutationOptions, state.toggle),
    useMigrateRoute: write(hooks.migrateRouteMutationOptions, state.migrate),
    useTransferRoute: idle,
    useCreateQr: idle,
    useQrCodes: () => ({ data: undefined }),
    useDebounce: <T,>(value: T) => value,
    usePrefetchAllDomainRoutes: () => undefined,
  };
});
vi.mock('@/context', () => ({
  SUPPORTED_DOMAINS: ['example.com', 'links.example.com'],
  useRoutesFilters: () => ({ filters: state.filters, setFilters: vi.fn<() => void>() }),
}));
vi.mock('@/components/link-preview', () => ({ LinkPreview: () => null }));
vi.mock('sonner', () => ({ toast: toasts }));

import { routeKeys } from '@/hooks/use-routes';
import { useRoutesByTarget } from '@/hooks/use-storage';
import {
  keyOfInput,
  keyOfStored,
  pendingRoutes,
  ROUTE_WRITE_PENDING_MESSAGE,
} from '@/lib/route-pending';
import { RoutesPage } from './routes';

const DOMAIN = 'example.com';

function route(overrides: Partial<Route> = {}): Route {
  return {
    path: '/talk',
    type: 'redirect',
    target: 'https://example.com/talk',
    statusCode: 302,
    preserveQuery: true,
    preservePath: false,
    enabled: true,
    domain: DOMAIN,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.routes = [route()];
  state.invalid = [];
  state.filters = {};
  for (const mock of [
    state.list,
    state.byTarget,
    state.create,
    state.update,
    state.migrate,
    state.remove,
    state.toggle,
  ]) {
    mock.mockReset();
  }
  // Every fetch answers what the server holds now: `state`'s rows
  state.list.mockImplementation(() =>
    Promise.resolve({
      routes: state.routes,
      invalidRoutes: state.invalid,
      total: state.routes.length + state.invalid.length,
      offset: 0,
      hasMore: false,
    }),
  );
  state.create.mockResolvedValue({ route: route(), readBack: false });
  state.update.mockResolvedValue(route());
  state.toggle.mockResolvedValue(route());
  state.remove.mockResolvedValue(undefined);
  toasts.success.mockReset();
  toasts.error.mockReset();
  pendingRoutes.clear();
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

/** Settle the query cache, which tells its observers on a timer. */
const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

async function render(
  client = new QueryClient(),
  entry: string | { pathname: string; state: unknown } = '/routes',
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <RoutesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  // The list query's first answer has landed
  await vi.waitFor(async () => {
    await settle();
    expect(document.body.textContent).not.toContain('Loading...');
  });
}

async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => element.click());
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    item => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

async function type(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector);
  expect(element, `input ${selector}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const rowOf = (path: string, domain?: string) =>
  [...document.querySelectorAll('tr')].find(
    item =>
      item.textContent?.includes(path) &&
      (domain === undefined || item.textContent.includes(domain)),
  );

async function clickRow(path: string) {
  await click(rowOf(path) ?? null);
}

/** Open the actions menu of the row showing `path` and choose `label`. */
async function rowAction(path: string, label: string) {
  const trigger = rowOf(path)?.querySelector<HTMLElement>('td:last-child button');
  expect(trigger).not.toBeNull();
  await act(async () =>
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    ),
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    element => element.textContent?.trim() === label,
  );
  await click(item ?? null);
}

async function openEdit(path: string, client?: QueryClient) {
  await render(client);
  await clickRow(path);
}

const badge = (path: string, domain?: string) =>
  rowOf(path, domain)?.textContent?.match(/Active|Disabled/)?.[0];

/** Wait for the page to show what `check` expects (the cache tells observers on a timer). */
const shows = (check: () => void) =>
  vi.waitFor(async () => {
    await settle();
    check();
  });

/** A promise and the function that settles it, for an answer still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settleWith => {
    resolve = settleWith;
  });
  return { promise, resolve };
}

/** The `expectedUpdatedAt` each update sent. */
const sentStamps = () =>
  state.update.mock.calls.map(
    call => (call[0] as { expectedUpdatedAt?: number }).expectedUpdatedAt,
  );

/** The Worker's 409 for a route changed since it was loaded. */
const changed = () =>
  new ApiError(409, 'This route changed while it was being edited', undefined, {
    code: 'ROUTE_SOURCE_CHANGED',
  });

/** Storage's "Associated Routes" panel, reduced to its first row. */
function Associated({ onRow }: { onRow: (row: Route | undefined) => void }) {
  const row = useRoutesByTarget('files', 'talk.pdf').data?.[0];
  useEffect(() => onRow(row), [row, onRow]);
  return null;
}

describe('reading the listed row after a write, before and after a stale refetch (v1.41.1)', () => {
  it('a save, then a reopen, sends the answer’s updatedAt; a stale refetch changes nothing', async () => {
    state.update.mockResolvedValueOnce(route({ preserveQuery: false, updatedAt: 3 }));
    await openEdit('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    // The dialog closed and the invalidation refetched the stale row (2)
    await shows(() => {
      expect(document.querySelector('#preserveQuery')).toBeNull();
      expect(state.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await clickRow('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(sentStamps()).toEqual([2, 3]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  // v1.41.0's identity rule failed here: the change reverted made the
  // answer's identity match an older cached row again
  it('toggled twice sends opposite values; a click while the first is in flight sends nothing', async () => {
    const first = deferred<Route>();
    state.toggle.mockReturnValueOnce(first.promise);
    state.toggle.mockResolvedValueOnce(route({ enabled: true, updatedAt: 4 }));
    await render();
    await rowAction('/talk', 'Disable');
    expect(state.toggle).toHaveBeenCalledTimes(1);
    // In flight: the row's actions are disabled, and a click sends nothing
    await shows(() => expect(rowOf('/talk')?.getAttribute('aria-busy')).toBe('true'));
    await rowAction('/talk', 'Disable');
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent?.trim())).toContain('Disable');
    const disabled = items
      .filter(element => element.hasAttribute('data-disabled'))
      .map(element => element.textContent?.trim());
    expect(disabled).toEqual(['Edit', 'Disable', 'Delete']);
    // A disabled item leaves its menu open: close it
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await clickRow('/talk');
    expect(state.toggle).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#target')).toBeNull();
    await act(async () => first.resolve(route({ enabled: false, updatedAt: 3 })));
    await shows(() => expect(badge('/talk')).toBe('Disabled'));
    await rowAction('/talk', 'Enable');
    await shows(() => expect(badge('/talk')).toBe('Active'));
    expect(state.toggle.mock.calls.map(call => (call[0] as { enabled: boolean }).enabled)).toEqual([
      false,
      true,
    ]);
    expect(toasts.success.mock.calls.map(call => call[0])).toEqual([
      'Route disabled',
      'Route enabled',
    ]);
  });

  it('an editor opened on a route whose write is in flight cannot save it, then or after', async () => {
    const first = deferred<Route>();
    state.toggle.mockReturnValueOnce(first.promise);
    await render();
    await rowAction('/talk', 'Disable');
    // "View in Routes" from Storage opens the editor while the toggle runs
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(undefined, { pathname: '/routes', state: { editRoute: route() } });
    await click(document.querySelector('#preserveQuery'));
    const save = button('Saving...');
    expect(save.disabled).toBe(true);
    // A forced submit is refused by the write itself (the toggle holds the
    // route): no request, and the toast says why
    await act(async () => save.closest('form')?.requestSubmit());
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenLastCalledWith(
      'Failed to update route: Another change to this route is still saving',
    );
    await act(async () => first.resolve(route({ enabled: false, updatedAt: 3 })));
    await shows(() => expect(button('Update').disabled).toBe(false));
    // The toggle answered while the editor was open: its copy (updatedAt 2,
    // enabled) is not the route any more, so Save sends nothing and closes
    await click(button('Update'));
    expect(state.update).not.toHaveBeenCalled();
    expect(document.querySelector('#preserveQuery')).toBeNull();
    expect(toasts.error).toHaveBeenLastCalledWith(
      'This route changed while it was open. Reopen it to edit the current version.',
    );
    // Reopened, it edits the toggle's answer
    state.update.mockResolvedValueOnce(
      route({ enabled: false, preserveQuery: false, updatedAt: 4 }),
    );
    await shows(() => expect(badge('/talk')).toBe('Disabled'));
    await clickRow('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(sentStamps()).toEqual([3]);
  });

  it('a migration confirmed after an own write answered at its new path sends nothing', async () => {
    state.routes = [route(), route({ path: '/new-talk', updatedAt: 5 })];
    const toggle = deferred<Route>();
    state.toggle.mockReturnValueOnce(toggle.promise);
    await render();
    await rowAction('/new-talk', 'Disable');
    await clickRow('/talk');
    await type('#path', '/new-talk');
    await click(button('Update'));
    // The destination's toggle answers while the confirmation is open
    await act(async () =>
      toggle.resolve(route({ path: '/new-talk', enabled: false, updatedAt: 6 })),
    );
    await click(button('Migrate Route'));
    expect(state.migrate).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenLastCalledWith(
      'This route changed while it was open. Reopen it to edit the current version.',
    );
    expect(document.querySelector('#path')).toBeNull();
  });

  it('a migration into a route whose write is in flight is refused with a toast', async () => {
    state.routes = [route(), route({ path: '/new-talk', updatedAt: 5 })];
    const toggle = deferred<Route>();
    state.toggle.mockReturnValueOnce(toggle.promise);
    await render();
    await rowAction('/new-talk', 'Disable');
    await clickRow('/talk');
    await type('#path', '/new-talk');
    await click(button('Update'));
    await click(button('Migrate Route'));
    expect(state.migrate).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenLastCalledWith(
      'Failed to migrate route: Another change to this route is still saving',
    );
    await act(async () =>
      toggle.resolve(route({ path: '/new-talk', enabled: false, updatedAt: 6 })),
    );
  });

  it('the status filter reads the same row: a disabled route leaves the Active view', async () => {
    state.filters = { enabled: true };
    state.toggle.mockResolvedValueOnce(route({ enabled: false, updatedAt: 3 }));
    await render();
    await rowAction('/talk', 'Disable');
    await shows(() => expect(rowOf('/talk')).toBeUndefined());
  });

  it("another domain's row at the same path is untouched", async () => {
    state.routes = [route(), route({ domain: 'links.example.com' })];
    state.toggle.mockResolvedValueOnce(route({ enabled: false, updatedAt: 3 }));
    await render();
    await rowAction('/talk', 'Disable');
    await shows(() => {
      const badges = [...document.querySelectorAll('tr')]
        .filter(item => item.textContent?.includes('/talk'))
        .map(item => item.textContent?.match(/Active|Disabled/)?.[0]);
      expect(badges).toEqual(['Disabled', 'Active']);
    });
  });

  it('a deleted route stays hidden after a refetch that still lists it', async () => {
    await render();
    await rowAction('/talk', 'Delete');
    await click(button('Delete'));
    expect(state.remove).toHaveBeenCalledWith({ path: '/talk', domain: DOMAIN });
    await shows(() => {
      expect(state.list.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(rowOf('/talk')).toBeUndefined();
    });
  });

  // Storage's "Associated Routes" is a by-target query shown through the same
  // store, and "View in Routes" opens the editor from its row
  it('Storage "View in Routes" after a save opens on the saved updatedAt', async () => {
    const client = new QueryClient();
    state.byTarget.mockResolvedValue([route({ type: 'r2', target: 'talk.pdf' })]);
    state.update.mockResolvedValueOnce(
      route({ type: 'r2', target: 'talk.pdf', forceDownload: true, updatedAt: 3 }),
    );
    state.routes = [route({ type: 'r2', target: 'talk.pdf' })];
    await openEdit('/talk', client);
    await click(document.querySelector('#forceDownload'));
    await click(button('Update'));
    // The Storage panel's query, as it reads its (stale) answer
    const viewed = { current: undefined as Route | undefined };
    const see = (row: Route | undefined) => {
      viewed.current = row;
    };
    const panel = document.createElement('div');
    const panelRoot = createRoot(panel);
    await act(async () =>
      panelRoot.render(
        <QueryClientProvider client={client}>
          <Associated onRow={see} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await settle();
      expect(viewed.current?.updatedAt).toBe(3);
    });
    expect(viewed.current?.domain).toBe(DOMAIN);
    await act(async () => panelRoot.unmount());
    // "View in Routes": the Routes page opened with the by-target row
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(client, { pathname: '/routes', state: { editRoute: viewed.current } });
    await click(document.querySelector('#forceDownload'));
    await click(button('Update'));
    expect(sentStamps()).toEqual([2, 3]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  // Another writer changed the route after this session's save: the answer
  // masks the server's row until the server refuses the stale stamp (409),
  // which forgets it; the dialog closes and the reopen edits the server's row
  it('a 409 closes the dialog, and the reopen uses the refetched row', async () => {
    state.update.mockResolvedValueOnce(route({ preserveQuery: false, updatedAt: 3 }));
    await openEdit('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    await shows(() => expect(document.querySelector('#preserveQuery')).toBeNull());
    state.routes = [route({ updatedAt: 7 })];
    state.update.mockRejectedValueOnce(changed());
    await clickRow('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/changed since you opened it/));
    await shows(() => expect(document.querySelector('#preserveQuery')).toBeNull());
    // The forgotten answer lets the refetched row (7) through
    await shows(() => {
      expect(state.list.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    await clickRow('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(sentStamps()).toEqual([2, 3, 7]);
  });
});

const CHANGED_WHILE_OPEN =
  'This route changed while it was open. Reopen it to edit the current version.';

const UNCERTAIN_MIGRATION =
  'Could not confirm the migration: it may have gone through. The list is reloading.';

/** The button labelled `text`, if one is rendered. */
const findButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    item => item.textContent?.trim() === text,
  );

/** Remount the Routes page opened with `editRoute` in its navigation state. */
async function openFromNavigation(editRoute: Route) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(undefined, { pathname: '/routes', state: { editRoute } });
}

// v1.41.1 review: an editor compares, at submit, the version it opened with
// the store's entry for its route (equality only), however it was opened
describe('an editor opened on a version this session has since replaced sends nothing', () => {
  // The QR page's "View route" toast holds the route as the QR editor made
  // it; a toggle answered another version before the toast was clicked
  it('the QR page’s "View route" toast after a toggle answered: refused, no request', async () => {
    const fromToast = route();
    state.toggle.mockResolvedValueOnce(route({ enabled: false, updatedAt: 3 }));
    await render();
    await rowAction('/talk', 'Disable');
    await shows(() => expect(badge('/talk')).toBe('Disabled'));
    await openFromNavigation(fromToast);
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenLastCalledWith(CHANGED_WHILE_OPEN);
    expect(document.querySelector('#preserveQuery')).toBeNull();
  });

  it('an editor opened on a route this session deleted since: refused, no request', async () => {
    await render();
    await rowAction('/talk', 'Delete');
    await click(button('Delete'));
    await shows(() => expect(rowOf('/talk')).toBeUndefined());
    await openFromNavigation(route());
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenLastCalledWith(CHANGED_WHILE_OPEN);
  });

  it('an editor opened on the version this session answered saves as usual', async () => {
    state.toggle.mockResolvedValueOnce(route({ enabled: false, updatedAt: 3 }));
    state.update.mockResolvedValueOnce(
      route({ enabled: false, preserveQuery: false, updatedAt: 4 }),
    );
    await render();
    await rowAction('/talk', 'Disable');
    await shows(() => expect(badge('/talk')).toBe('Disabled'));
    await openFromNavigation(route({ enabled: false, updatedAt: 3 }));
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(sentStamps()).toEqual([3]);
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

// v1.41.1 review: a route stored without `enabled` is active (its row says
// so), so its toggle disables it, as the row's own "Disable" says
describe('a route stored without `enabled`', () => {
  it('Disable sends enabled false, and the toast and credential confirmation say so', async () => {
    const legacy = route();
    delete legacy.enabled;
    state.routes = [legacy];
    state.toggle.mockRejectedValueOnce(
      new ApiError(
        400,
        'Credential-named target parameter',
        { parameters: ['token'] },
        {
          code: 'ROUTE_TARGET_CREDENTIAL',
        },
      ),
    );
    state.toggle.mockResolvedValueOnce(route({ enabled: false, updatedAt: 3 }));
    await render();
    expect(badge('/talk')).toBe('Active');
    await rowAction('/talk', 'Disable');
    await click(button('Disable anyway'));
    expect(state.toggle.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ enabled: false, acknowledgeCredentialTarget: undefined }),
      expect.objectContaining({ enabled: false, acknowledgeCredentialTarget: true }),
    ]);
    expect(toasts.success).toHaveBeenLastCalledWith('Route disabled');
    await shows(() => expect(badge('/talk')).toBe('Disabled'));
  });
});

describe('the route queries are keyed as the hooks key them', () => {
  it('the page reads the list query routeKeys.list names', async () => {
    const client = new QueryClient();
    await render(client);
    const cached = client
      .getQueryCache()
      .findAll({ queryKey: routeKeys.all })
      .map(query => query.queryKey[0]);
    expect(cached).toContain('routes');
  });
});

// v1.41.1 review: an uncertain failure is not an answer, so it never makes
// the write's own retry look like a change made while the dialog was open
describe('an own uncertain failure never refuses its own retry', () => {
  it('a migration answered 502, reopened and confirmed again, is sent', async () => {
    state.migrate.mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'));
    state.migrate.mockResolvedValueOnce(route({ path: '/new-talk', updatedAt: 3 }));
    await render();
    await clickRow('/talk');
    await type('#path', '/new-talk');
    await click(button('Update'));
    const destination = keyOfInput(DOMAIN, '/new-talk');
    const generation = pendingRoutes.generation(destination);
    await click(button('Migrate Route'));
    expect(state.migrate).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenLastCalledWith(UNCERTAIN_MIGRATION);
    // The failure is no answer: neither path's generation moved, so no
    // confirmation (open, or captured before it) reads it as a change
    expect(pendingRoutes.generation(destination)).toBe(generation);
    expect(pendingRoutes.generation(keyOfInput(DOMAIN, '/talk'))).toBe(0);
    // v1.41.2: the route may have moved, so both dialogs closed
    await shows(() => expect(document.querySelector('#path')).toBeNull());
    expect(findButton('Migrate Route')).toBeUndefined();
    // Reopened from the refetched list and confirmed again, it is sent
    await clickRow('/talk');
    await type('#path', '/new-talk');
    await click(button('Update'));
    await click(button('Migrate Route'));
    expect(state.migrate).toHaveBeenCalledTimes(2);
    expect(toasts.error).not.toHaveBeenCalledWith(CHANGED_WHILE_OPEN);
    expect(toasts.success).toHaveBeenLastCalledWith('Route migrated from /talk to /new-talk');
  });
});

// v1.41.1 review: the recovery delete's entry (`gone-unreadable`) shares its
// key with a readable route at the same path, and says nothing about it
describe('a recovered unreadable record and a readable route at the same path', () => {
  it('recover unreadable /promo, a readable /promo appears, and its editor saves', async () => {
    state.routes = [];
    state.invalid = [{ domain: DOMAIN, path: '/promo', invalid: true }];
    state.update.mockResolvedValueOnce(
      route({ path: '/promo', preserveQuery: false, updatedAt: 4 }),
    );
    await render();
    // What the server holds once the record is recovered: a readable /promo
    // written since (by another writer)
    state.invalid = [];
    state.routes = [route({ path: '/promo', updatedAt: 3 })];
    await click(document.querySelector('[aria-label="Delete unreadable record /promo"]'));
    await click(button('Delete'));
    expect(state.remove).toHaveBeenCalledWith({
      path: '/promo',
      domain: DOMAIN,
      recoverInvalid: true,
    });
    await shows(() => expect(rowOf('/promo')).toBeDefined());
    expect(document.querySelector('[data-testid="unreadable-route"]')).toBeNull();
    await clickRow('/promo');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(sentStamps()).toEqual([3]);
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

// v1.41.2: a write that may have landed is never reported as failed; a
// definite refusal still is
describe('a route write with no definite answer says it could not be confirmed', () => {
  it('a migration answered 502: the uncertain toast, and both dialogs close', async () => {
    state.migrate.mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'));
    await openEdit('/talk');
    await type('#path', '/new-talk');
    await click(button('Update'));
    await click(button('Migrate Route'));
    expect(toasts.error).toHaveBeenLastCalledWith(UNCERTAIN_MIGRATION);
    expect(toasts.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Failed to migrate route/),
    );
    await shows(() => expect(document.querySelector('#path')).toBeNull());
    expect(findButton('Migrate Route')).toBeUndefined();
  });

  it('a migration answered 400: the failed toast, and the dialogs stay as before', async () => {
    state.migrate.mockRejectedValueOnce(new ApiError(400, 'Validation failed'));
    await openEdit('/talk');
    await type('#path', '/new-talk');
    await click(button('Update'));
    await click(button('Migrate Route'));
    expect(toasts.error).toHaveBeenLastCalledWith('Failed to migrate route: Validation failed');
    // As before: the confirmation closed with its click, the editor stays
    // open on the typed path for another try
    expect(findButton('Migrate Route')).toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('#path')?.value).toBe('/new-talk');
  });

  it('an update, a toggle and a delete with no definite answer say so, and close', async () => {
    state.update.mockRejectedValueOnce(new ApiError(503, 'Unavailable'));
    state.toggle.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    state.remove.mockRejectedValueOnce(new ApiError(0, 'Failed to delete route'));
    await openEdit('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(toasts.error).toHaveBeenLastCalledWith(
      'Could not confirm the update: it may have gone through. The list is reloading.',
    );
    // The update may have landed: the editor closed
    await shows(() => expect(document.querySelector('#preserveQuery')).toBeNull());
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await rowAction('/talk', 'Disable');
    await shows(() =>
      expect(toasts.error).toHaveBeenLastCalledWith(
        'Could not confirm the change: it may have gone through. The list is reloading.',
      ),
    );
    await rowAction('/talk', 'Delete');
    await click(button('Delete'));
    expect(toasts.error).toHaveBeenLastCalledWith(
      'Could not confirm the delete: it may have gone through. The list is reloading.',
    );
    // The delete may have landed: its confirmation closed
    await shows(() => expect(findButton('Delete')).toBeUndefined());
  });

  it('a create answered 502 says it could not be confirmed, and its dialog closes', async () => {
    state.create.mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'));
    await render();
    await click(button('New Route'));
    await type('#path', '/new');
    await type('#target', 'https://example.com/new');
    await click(button('Create'));
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenLastCalledWith(
      'Could not confirm the new route: it may have gone through. The list is reloading.',
    );
    await shows(() => expect(document.querySelector('#target')).toBeNull());
  });

  it('a definite refusal of a create keeps its dialog open', async () => {
    state.create.mockRejectedValueOnce(new ApiError(409, 'Route already exists'));
    await render();
    await click(button('New Route'));
    await type('#path', '/new');
    await type('#target', 'https://example.com/new');
    await click(button('Create'));
    expect(toasts.error).toHaveBeenLastCalledWith('Failed to create route: Route already exists');
    expect(document.querySelector('#target')).not.toBeNull();
  });
});

// v1.41.2: a migration's destination where this session's own write answered
// a route within the 90 s (a create KV does not list yet)
describe('a migration into a route this session just wrote', () => {
  it('create /new, then migrate /talk to /new: refused, no request', async () => {
    state.create.mockResolvedValueOnce({
      route: route({ path: '/new', updatedAt: 3 }),
      readBack: false,
    });
    await render();
    await click(button('New Route'));
    await type('#path', '/new');
    await type('#target', 'https://example.com/new');
    await click(button('Create'));
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ domain: DOMAIN }));
    expect(toasts.success).toHaveBeenLastCalledWith(`Route created successfully on ${DOMAIN}`);
    // KV lags: the refetch does not list /new yet
    expect(rowOf('/new')).toBeUndefined();
    await clickRow('/talk');
    await type('#path', '/new');
    await click(button('Update'));
    await click(button('Migrate Route'));
    expect(state.migrate).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenLastCalledWith(
      'A route already exists at /new. Reopen it to choose another path.',
    );
    expect(document.querySelector('#path')).toBeNull();
    expect(findButton('Migrate Route')).toBeUndefined();
  });
});

describe('a migration to another spelling of its own path', () => {
  // The source's own key is not "a route this session wrote" at the
  // destination: the Worker answers it (400, the same path)
  it('is sent after a save of the route, and the Worker decides', async () => {
    state.update.mockResolvedValueOnce(route({ preserveQuery: false, updatedAt: 3 }));
    state.migrate.mockRejectedValueOnce(
      new ApiError(400, 'Old path and new path cannot be the same'),
    );
    await openEdit('/talk');
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(pendingRoutes.answerAt(keyOfStored(DOMAIN, '/talk'))?.state).toBe('live');
    await clickRow('/talk');
    await type('#path', '/talk/');
    await click(button('Update'));
    await click(button('Migrate Route'));
    expect(state.migrate).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenLastCalledWith(
      'Failed to migrate route: Old path and new path cannot be the same',
    );
  });
});

// v1.41.2: a click reads the writes in flight NOW, not the snapshot its
// render subscribed to; every row action is refused with the hooks' own
// message ("Another change to this route is still saving"), never silently
describe('a row handler from a render made before a write was acquired', () => {
  it('refuses to open the editor on a route a write now holds', async () => {
    await render();
    const row = rowOf('/talk');
    expect(row?.getAttribute('aria-busy')).toBeNull();
    // Acquired outside React: the row's handler is still the one rendered
    // with the old snapshot when it runs
    const held = pendingRoutes.acquire([keyOfInput(DOMAIN, '/talk')]);
    expect(held).not.toBeNull();
    row?.click();
    await settle();
    expect(document.querySelector('#path')).toBeNull();
    expect(toasts.error).toHaveBeenLastCalledWith(ROUTE_WRITE_PENDING_MESSAGE);
    if (held) await act(async () => pendingRoutes.release(held));
    await clickRow('/talk');
    expect(document.querySelector('#path')).not.toBeNull();
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it('a held row clicked in a current render is refused with the same toast', async () => {
    await render();
    const held = pendingRoutes.acquire([keyOfInput(DOMAIN, '/talk')]);
    expect(held).not.toBeNull();
    await shows(() => expect(rowOf('/talk')?.getAttribute('aria-busy')).toBe('true'));
    await clickRow('/talk');
    expect(document.querySelector('#path')).toBeNull();
    expect(toasts.error).toHaveBeenLastCalledWith(ROUTE_WRITE_PENDING_MESSAGE);
    if (held) await act(async () => pendingRoutes.release(held));
  });

  it.each(['Edit', 'Delete'])(
    'the %s item from an older render opens nothing and says why',
    async label => {
      await render();
      const trigger = rowOf('/talk')?.querySelector<HTMLElement>('td:last-child button');
      await act(async () =>
        trigger?.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
        ),
      );
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        element => element.textContent?.trim() === label,
      );
      expect(item?.hasAttribute('data-disabled')).toBe(false);
      const held = pendingRoutes.acquire([keyOfInput(DOMAIN, '/talk')]);
      expect(held).not.toBeNull();
      item?.click();
      await settle();
      expect(document.querySelector('#path')).toBeNull();
      expect(findButton('Delete')).toBeUndefined();
      expect(toasts.error).toHaveBeenLastCalledWith(ROUTE_WRITE_PENDING_MESSAGE);
      if (held) await act(async () => pendingRoutes.release(held));
    },
  );

  it('a row toggle sends nothing and says why', async () => {
    await render();
    await rowAction('/talk', 'Disable');
    await shows(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    state.toggle.mockClear();
    // Open the menu, then acquire outside React: the item's handler is the
    // one rendered with the old snapshot when it runs
    const trigger = rowOf('/talk')?.querySelector<HTMLElement>('td:last-child button');
    await act(async () =>
      trigger?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
      ),
    );
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element =>
      ['Disable', 'Enable'].includes(element.textContent?.trim() ?? ''),
    );
    expect(item?.hasAttribute('data-disabled')).toBe(false);
    const held = pendingRoutes.acquire([keyOfInput(DOMAIN, '/talk')]);
    expect(held).not.toBeNull();
    item?.click();
    await settle();
    expect(state.toggle).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenLastCalledWith(ROUTE_WRITE_PENDING_MESSAGE);
    if (held) await act(async () => pendingRoutes.release(held));
  });

  it('an unreadable row’s Delete opens nothing while its exact key is held', async () => {
    state.invalid = [{ domain: DOMAIN, path: '/Promo', invalid: true }];
    await render();
    const remove = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete unreadable record /Promo"]',
    );
    expect(remove?.disabled).toBe(false);
    const held = pendingRoutes.acquire([keyOfStored(DOMAIN, '/Promo')]);
    expect(held).not.toBeNull();
    remove?.click();
    await settle();
    expect(findButton('Delete')).toBeUndefined();
    expect(toasts.error).toHaveBeenLastCalledWith(ROUTE_WRITE_PENDING_MESSAGE);
    if (held) await act(async () => pendingRoutes.release(held));
  });

  it('an unreadable /Promo whose recovery is in flight leaves a readable /promo writable', async () => {
    state.routes = [route({ path: '/promo' })];
    state.invalid = [{ domain: DOMAIN, path: '/Promo', invalid: true }];
    const recovery = deferred<undefined>();
    state.remove.mockReturnValueOnce(recovery.promise);
    await render();
    await click(document.querySelector('[aria-label="Delete unreadable record /Promo"]'));
    await click(button('Delete'));
    // The recovery holds its exact key: the readable /promo is another key
    await shows(() =>
      expect(
        document.querySelector<HTMLButtonElement>('[aria-label="Delete unreadable record /Promo"]')
          ?.disabled,
      ).toBe(true),
    );
    expect(rowOf('/promo')?.getAttribute('aria-busy')).toBeNull();
    await act(async () => recovery.resolve(undefined));
  });
});
