import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterProvider } from '@/context';
import { buildRecentActivityHref } from '@/lib/dashboard-navigation';
import { DownloadsPage } from './downloads';
import { ProxyPage } from './proxy';
import { RedirectsPage } from './redirects';
import { ViewsPage } from './views';

/**
 * Recent Activity deep links must actually FILTER the page they land on.
 *
 * Filter state lives in a React context that the URL never fed, so a link
 * carrying `?domain=…&days=…&country=…&search=…` used to render whatever
 * filters happened to be in memory. That defect survived review because the
 * only coverage asserted the href STRING. These tests assert the other end:
 * the page is rendered at the deep-link URL and the parameters must reach the
 * data-fetching hook.
 */
const empty = { data: undefined, isLoading: false, isFetching: false, error: null };
const hooks = vi.hoisted(() => ({
  useClicks: vi.fn<(params: unknown) => unknown>(),
  useViews: vi.fn<(params: unknown) => unknown>(),
  useDownloads: vi.fn<(params: unknown) => unknown>(),
  useProxyRequests: vi.fn<(params: unknown) => unknown>(),
}));

// The hooks barrel pulls in the API/query clients, which touch `window` at
// import time, so it is replaced wholesale rather than spread over the real
// module. `useDebounce` is a pass-through here: its real form already returns
// the initial value synchronously, so the first render carries the hydrated
// search term either way.
vi.mock('@/hooks', () => ({ ...hooks, useDebounce: <T,>(value: T) => value }));

/** The first argument of a hook mock's first call; fails by name when the hook never ran. */
function firstCallArgument(hook: (typeof hooks)[keyof typeof hooks]): unknown {
  const call = hook.mock.calls[0];
  assert(call !== undefined, 'expected the data hook to have been called');
  return call[0];
}

function renderAt(url: string, page: React.ReactNode) {
  return renderToStaticMarkup(
    <FilterProvider>
      <MemoryRouter initialEntries={[url]}>{page}</MemoryRouter>
    </FilterProvider>,
  );
}

describe('analytics deep links hydrate from the URL', () => {
  beforeEach(() => {
    for (const hook of Object.values(hooks)) {
      hook.mockReset();
      hook.mockReturnValue(empty);
    }
  });

  it('carries a Recent Activity href straight into the redirects query', () => {
    // Build the href exactly as the dashboard does, so the two ends cannot
    // drift apart without a test failing.
    const href = buildRecentActivityHref(
      { type: 'click', domain: 'links.example.com', path: '/welcome', country: 'SG' },
      7,
      false,
    );
    renderAt(href, <RedirectsPage />);

    expect(hooks.useClicks).toHaveBeenCalled();
    expect(firstCallArgument(hooks.useClicks)).toMatchObject({
      domain: 'links.example.com',
      days: 7,
      country: 'SG',
      slug: '/welcome',
    });
  });

  it.each([
    ['views', ViewsPage, hooks.useViews],
    ['downloads', DownloadsPage, hooks.useDownloads],
    ['proxy', ProxyPage, hooks.useProxyRequests],
  ])('hydrates the %s page from its own deep link', (_name, Page, hook) => {
    renderAt('/?domain=example.com&days=30&country=GB&search=%2Freport', <Page />);

    expect(hook).toHaveBeenCalled();
    expect(firstCallArgument(hook)).toMatchObject({
      domain: 'example.com',
      days: 30,
      country: 'GB',
      path: '/report',
    });
  });

  it('falls back to stored filters when the URL carries no filter parameters', () => {
    // An ordinary in-app navigation must not reset the page to defaults.
    renderAt('/', <RedirectsPage />);

    expect(firstCallArgument(hooks.useClicks)).toMatchObject({
      domain: undefined,
      country: undefined,
      slug: undefined,
    });
  });

  it('rejects values the UI could never have produced', () => {
    // The URL is user-controlled. An unsupported domain, an unoffered period,
    // and a malformed country must not reach the API.
    renderAt('/?domain=evil.example.net&days=9999&country=NOTACODE&search=x', <RedirectsPage />);

    expect(firstCallArgument(hooks.useClicks)).toMatchObject({
      domain: undefined,
      country: undefined,
      days: 1,
      slug: 'x',
    });
  });

  it('clamps an over-long search term before it reaches the API', () => {
    renderAt(`/?search=${'a'.repeat(900)}`, <RedirectsPage />);

    expect((firstCallArgument(hooks.useClicks) as { slug: string }).slug).toHaveLength(512);
  });
});
