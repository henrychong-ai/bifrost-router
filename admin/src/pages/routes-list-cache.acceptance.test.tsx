// @vitest-environment happy-dom

/**
 * Reading the listed row after a write, before the refetch lands (v1.41.0).
 * Each write's answer replaces its row in the cached route listings
 * (`applyRouteSaved` in `use-routes.ts`), so everything that reads the row
 * (the toggle's label and value, the Active/Disabled badge, the status filter,
 * the editor and the `expectedUpdatedAt` it sends) agrees before the refetch
 * lands. Before v1.41.0 a route reopened right after its own save sent the
 * old `updatedAt` and met a self-inflicted 409, and a second toggle repeated
 * the first. Here the list is a real query whose refetch never lands, so the
 * page can only read the cached rows.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRouteSaved, cachedRouteVersion, routeKeys } from '@/hooks/use-routes';
import type { Route } from '@/lib/schemas';

const state = vi.hoisted(() => ({
  routes: [] as Route[],
  filters: {} as Record<string, unknown>,
  update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toggle: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
}));

const { idle } = vi.hoisted(() => ({
  idle: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
}));

vi.mock('@/hooks', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    routeKeys: { list: (...args: unknown[]) => ['routes', ...args] },
    // A real list query keyed as `routeKeys.list` keys it, so a write's answer
    // lands in it as it does in the app. It starts on `state`, and its refetch
    // never lands
    useRoutes: (domain?: string) =>
      useQuery({
        queryKey: ['routes', { domain }],
        queryFn: () => new Promise<never>(() => undefined),
        initialData: () => ({
          routes: state.routes,
          invalidRoutes: [],
          total: state.routes.length,
          offset: 0,
          hasMore: false,
        }),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    useCreateRoute: idle,
    useUpdateRoute: () => ({ mutateAsync: state.update, isPending: false }),
    useDeleteRoute: idle,
    useToggleRoute: () => ({ mutateAsync: state.toggle, isPending: false }),
    useMigrateRoute: idle,
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

import { RoutesPage } from './routes';

function route(overrides: Partial<Route> = {}): Route {
  return {
    path: '/talk',
    type: 'redirect',
    target: 'https://example.com/talk',
    statusCode: 302,
    preserveQuery: true,
    preservePath: false,
    enabled: true,
    domain: 'example.com',
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
  state.filters = {};
  state.update.mockReset();
  state.toggle.mockReset();
  toasts.success.mockReset();
  toasts.error.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  client: QueryClient,
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

const rowOf = (path: string, domain?: string) =>
  [...document.querySelectorAll('tr')].find(
    item =>
      item.textContent?.includes(path) &&
      (domain === undefined || item.textContent.includes(domain)),
  );

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

/**
 * A client whose toggle and update answers land in the list as the hooks
 * write them: each answer is the route as sent, one millisecond newer,
 * superseding the version the update sent or, for a toggle, the cached one.
 */
function writingClient() {
  const client = new QueryClient();
  let updatedAt = 2;
  const answer = (...args: unknown[]) => {
    const variables = args[0] as {
      path: string;
      domain: string;
      enabled?: boolean;
      data?: Partial<Route>;
      expectedUpdatedAt?: number;
    };
    const superseded =
      variables.expectedUpdatedAt ?? cachedRouteVersion(client, variables.domain, variables.path);
    updatedAt += 1;
    const current = state.routes.find(
      row => row.path === variables.path && row.domain === variables.domain,
    );
    const saved = route({
      ...current,
      ...variables.data,
      ...(variables.enabled === undefined ? {} : { enabled: variables.enabled }),
      domain: undefined,
      updatedAt,
    });
    applyRouteSaved(client, variables, saved, superseded);
    return Promise.resolve(saved);
  };
  state.toggle.mockImplementation(answer);
  state.update.mockImplementation(answer);
  return client;
}

const badge = (path: string, domain?: string) =>
  rowOf(path, domain)?.textContent?.match(/Active|Disabled/)?.[0];

/** The query cache tells its observers on a timer: wait for the row to show `label`. */
const badgeBecomes = (label: string) =>
  vi.waitFor(async () => {
    await act(async () => undefined);
    expect(badge('/talk')).toBe(label);
  });

describe('reading the listed row after a write, before the refetch lands (v1.41.0)', () => {
  it('toggled twice before the list refetches: Disable, then Enable, then Disable', async () => {
    await render(writingClient());
    await rowAction('/talk', 'Disable');
    await badgeBecomes('Disabled');
    await rowAction('/talk', 'Enable');
    await badgeBecomes('Active');
    await rowAction('/talk', 'Disable');
    expect(state.toggle.mock.calls.map(call => (call[0] as { enabled: boolean }).enabled)).toEqual([
      false,
      true,
      false,
    ]);
    expect(toasts.success.mock.calls.map(call => call[0])).toEqual([
      'Route disabled',
      'Route enabled',
      'Route disabled',
    ]);
  });

  it('the status filter reads the same row: a disabled route leaves the Active view', async () => {
    state.filters = { enabled: true };
    await render(writingClient());
    await rowAction('/talk', 'Disable');
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(rowOf('/talk')).toBeUndefined();
    });
  });

  it("another domain's row at the same path is untouched", async () => {
    state.routes = [route(), route({ domain: 'links.example.com' })];
    await render(writingClient());
    await rowAction('/talk', 'Disable');
    await vi.waitFor(async () => {
      await act(async () => undefined);
      const badges = [...document.querySelectorAll('tr')]
        .filter(item => item.textContent?.includes('/talk'))
        .map(item => item.textContent?.match(/Active|Disabled/)?.[0]);
      expect(badges).toEqual(['Disabled', 'Active']);
    });
  });

  it('a route reopened after its own save sends the saved updatedAt, never a stale one', async () => {
    const client = writingClient();
    await render(client);
    await click(rowOf('/talk') ?? null);
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    // The dialog closes on the save; the row then carries the saved updatedAt
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(document.querySelector('#preserveQuery')).toBeNull();
      const listed = client.getQueryData<{ routes: Route[] }>(['routes', { domain: undefined }]);
      expect(listed?.routes[0]?.updatedAt).toBe(3);
    });
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    await click(rowOf('/talk') ?? null);
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(
      state.update.mock.calls.map(
        call => (call[0] as { expectedUpdatedAt?: number }).expectedUpdatedAt,
      ),
    ).toEqual([2, 3]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  // v1.41.0 review: Storage's "Associated Routes" is a by-target query, and
  // "View in Routes" opens the editor from its row. A save writes that row
  // too, so the editor it opens sends the saved updatedAt
  it('Storage "View in Routes" after a save opens the saved updatedAt', async () => {
    const client = writingClient();
    const byTarget = routeKeys.byTarget('files', 'talk.pdf');
    client.setQueryData(byTarget, [route()]);
    // The save, as the editor sends it
    await state.update({ path: '/talk', domain: 'example.com', data: {} });
    const viewed = client.getQueryData<Route[]>(byTarget)?.[0];
    expect(viewed?.updatedAt).toBe(3);
    expect(viewed?.domain).toBe('example.com');
    // "View in Routes": the Routes page opened with the by-target row
    await render(client, { pathname: '/routes', state: { editRoute: viewed } });
    await click(document.querySelector('#preserveQuery'));
    await click(button('Update'));
    expect(
      state.update.mock.calls.map(
        call => (call[0] as { expectedUpdatedAt?: number }).expectedUpdatedAt,
      ),
    ).toEqual([undefined, 3]);
    expect(toasts.error).not.toHaveBeenCalled();
  });
});
