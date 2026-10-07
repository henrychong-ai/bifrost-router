// @vitest-environment happy-dom

/**
 * The route dialog end to end, with only the data hooks mocked (v1.38.0):
 * edits send only what changed, UTM tags are edited in lowercase into the
 * target, and r2 links get naming advice.
 */

import { MAX_ROUTE_TARGET_LENGTH } from '@bifrost/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import type { Route } from '@/lib/schemas';

const state = vi.hoisted(() => ({
  update: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  create: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  migrate: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  remove: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  invalidRoutes: [] as Array<{ domain: string; path: string; invalid: true }>,
  filters: { domain: 'example.com' } as Record<string, unknown>,
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
}));

vi.mock('@/hooks', () => ({
  routeKeys: { list: (...args: unknown[]) => ['routes', ...args] },
  useRoutes: () => ({
    data: {
      routes: [],
      invalidRoutes: state.invalidRoutes,
      total: state.invalidRoutes.length,
      offset: 0,
      hasMore: false,
    },
    isLoading: false,
  }),
  useCreateRoute: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateRoute: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteRoute: () => ({ mutateAsync: state.remove, isPending: false }),
  useToggleRoute: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
  useMigrateRoute: () => ({ mutateAsync: state.migrate, isPending: false }),
  useTransferRoute: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
  useCreateQr: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
  useQrCodes: () => ({ data: undefined }),
  useDebounce: <T,>(value: T) => value,
  usePrefetchAllDomainRoutes: () => undefined,
}));
vi.mock('@/context', () => ({
  SUPPORTED_DOMAINS: ['example.com'],
  useRoutesFilters: () => ({ filters: state.filters, setFilters: vi.fn<() => void>() }),
}));
vi.mock('@/components/link-preview', () => ({ LinkPreview: () => null }));
vi.mock('sonner', () => ({ toast: toasts }));

import { RoutesPage } from './routes';

const DOMAIN = 'example.com';
const base = { domain: DOMAIN, createdAt: 1, updatedAt: 1 } as const;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    item => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

async function typeInto(element: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The Routes page with the edit dialog open on `route` (navigation hand-off). */
async function editing(route: Route) {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[{ pathname: '/routes', state: { editRoute: route } }]}>
          <RoutesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function save() {
  await act(async () => button('Update').click());
}

async function click(element: HTMLElement | null) {
  if (!element) throw new Error('nothing to click');
  await act(async () => element.click());
}

/** Pick an option in the open dialog's Radix select labelled `label`. */
async function choose(label: string, option: string) {
  const dialog = document.querySelector('[role="dialog"]');
  const labelNode = [...(dialog?.querySelectorAll('label') ?? [])].find(
    node => node.textContent?.trim() === label,
  );
  const trigger = labelNode?.parentElement?.querySelector<HTMLElement>('[role="combobox"]');
  expect(trigger, `select ${label}`).not.toBeNull();
  await act(async () =>
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    ),
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    node => node.textContent?.trim() === option,
  );
  expect(item, `option ${option}`).toBeDefined();
  await click(item ?? null);
}

const sentData = () => state.update.mock.calls[0]?.[0]?.['data'];

beforeEach(() => {
  state.update.mockReset().mockResolvedValue({});
  state.create.mockReset().mockResolvedValue({});
  // The Worker answers the moved route with the edit applied (one write)
  state.migrate.mockReset().mockImplementation(async ({ newPath, updates }) => ({
    path: String(newPath),
    type: 'redirect',
    ...(typeof updates === 'object' && updates !== null ? updates : {}),
  }));
  state.remove.mockReset().mockResolvedValue(undefined);
  state.invalidRoutes = [];
  state.filters = { domain: 'example.com' };
  toasts.success.mockReset();
  toasts.error.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('editing a route sends only what changed', () => {
  const legacy: Route = {
    ...base,
    path: '/legacy',
    type: 'redirect',
    // Saved before today's target limit
    target: `https://example.com/?q=${'x'.repeat(MAX_ROUTE_TARGET_LENGTH)}`,
    statusCode: 302,
  };

  it('makes no request for an unchanged save', async () => {
    await editing(legacy);
    await save();
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith('No changes to save');
  });

  it('never re-sends an untouched over-limit target', async () => {
    await editing(legacy);
    await typeInto(input('cacheControl'), 'max-age=60');
    await save();
    expect(sentData()).toEqual({ cacheControl: 'max-age=60' });
  });

  it('sends an empty Cache-Control or Host header to clear a stored one', async () => {
    await editing({
      ...base,
      path: '/docs',
      type: 'proxy',
      target: 'https://origin.example.com/',
      cacheControl: 'max-age=60',
      hostHeader: 'origin.example.com',
    });
    await typeInto(input('cacheControl'), '');
    await typeInto(input('hostHeader'), '');
    await save();
    expect(sentData()).toEqual({ cacheControl: '', hostHeader: '' });
  });

  it('keeps an r2 route stored without forceDownload or bucket unset on an unchanged save', async () => {
    await editing({ ...base, path: '/brochure', type: 'r2', target: 'docs/brochure.pdf' });
    expect(document.body.textContent).toContain('not set: decided by the file type');
    await save();
    expect(state.update).not.toHaveBeenCalled();
  });
});

describe('UTM tracking in the route dialog', () => {
  const tagged: Route = {
    ...base,
    path: '/promo',
    type: 'redirect',
    target: 'https://example.net/landing?utm_source=News&ref=a#top',
    statusCode: 302,
  };

  it('shows the target’s tags in lowercase and saves edits into the target', async () => {
    await editing(tagged);
    expect(input('utm_source').value).toBe('news');
    expect(document.body.textContent).toContain(
      'Converted to lowercase once you edit the target or a UTM field',
    );
    await typeInto(input('utm_campaign'), 'Spring-Launch');
    expect(input('utm_campaign').value).toBe('spring-launch');
    expect(document.getElementById('utm-preview')?.textContent).toBe(
      'https://example.net/landing?ref=a&utm_source=news&utm_campaign=spring-launch#top',
    );
    await save();
    expect(sentData()).toEqual({
      target: 'https://example.net/landing?ref=a&utm_source=news&utm_campaign=spring-launch#top',
    });
  });

  it('never rewrites an untouched target with capitals when other fields change', async () => {
    await editing(tagged);
    await typeInto(input('cacheControl'), 'max-age=60');
    await save();
    expect(sentData()).toEqual({ cacheControl: 'max-age=60' });
    await act(async () => root?.unmount());
    state.update.mockClear();
    await editing(tagged);
    await click(document.getElementById('preserveQuery'));
    await save();
    expect(sentData()).toEqual({ preserveQuery: false });
  });

  it('is offered for redirect routes only: a proxy replaces the target query', async () => {
    await editing({
      ...base,
      path: '/svc',
      type: 'proxy',
      target: 'https://origin.example.com/?utm_source=News',
    });
    expect(document.getElementById('utm_source')).toBeNull();
    expect(document.body.textContent).not.toContain('UTM tracking');
    await typeInto(input('hostHeader'), 'origin.example.com');
    await save();
    // The proxy target is never recomposed
    expect(sentData()).toEqual({ hostHeader: 'origin.example.com' });
  });

  it('a path change confirmed as a migration saves the other changes in the SAME request', async () => {
    await editing(tagged);
    await typeInto(input('path'), '/promo-2');
    await typeInto(input('utm_campaign'), 'spring');
    await save();
    await click(button('Migrate Route'));
    // One request: never a move and then an update of the same new key
    expect(state.migrate).toHaveBeenCalledTimes(1);
    expect(state.migrate).toHaveBeenCalledWith({
      oldPath: '/promo',
      newPath: '/promo-2',
      domain: DOMAIN,
      updates: {
        target: 'https://example.net/landing?ref=a&utm_source=news&utm_campaign=spring#top',
      },
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith(
      'Route migrated from /promo to /promo-2 and updated',
    );
  });

  it('a failed migration moved nothing, and says so once', async () => {
    state.migrate.mockRejectedValueOnce(new Error('network down'));
    await editing(tagged);
    await typeInto(input('path'), '/promo-2');
    await typeInto(input('cacheControl'), 'no-store');
    await save();
    await click(button('Migrate Route'));
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith('Failed to migrate route: network down');
  });

  it('reports moved-but-not-saved only when the server moved the route without the changes', async () => {
    // An older Worker ignores the body and moves the record unedited
    state.migrate.mockImplementationOnce(async ({ newPath }) => ({
      path: String(newPath),
      type: 'redirect',
    }));
    await editing(tagged);
    await typeInto(input('path'), '/promo-2');
    await typeInto(input('cacheControl'), 'no-store');
    await save();
    await click(button('Migrate Route'));
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      'Route migrated from /promo to /promo-2, but its other changes were not saved (cacheControl): edit the route again to apply them',
    );
  });

  it('refuses to save a target that is not an absolute URL', async () => {
    await editing(tagged);
    await typeInto(input('target'), 'not a url');
    expect(document.body.textContent).toContain('Enter a valid absolute target URL before saving');
    expect(button('Update').disabled).toBe(true);
  });
});

describe('link-naming advice', () => {
  it('flags a dated, file-shaped r2 link without blocking the save', async () => {
    await editing({ ...base, path: '/brochure-final', type: 'r2', target: 'docs/brochure.pdf' });
    await typeInto(input('path'), '/20260923-brochure.pdf');
    const advice = document.body.querySelector('[aria-label="Link naming suggestions"]');
    expect(advice?.textContent).toContain('Remove the file extension (.pdf)');
    expect(advice?.textContent).toContain('Remove the date (20260923)');
    expect(button('Update').disabled).toBe(false);
  });

  it('gives no advice for a redirect', async () => {
    await editing({
      ...base,
      path: '/promo-2026',
      type: 'redirect',
      target: 'https://example.net/',
    });
    expect(document.body.querySelector('[aria-label="Link naming suggestions"]')).toBeNull();
  });
});

describe('a path change on a route whose stored target is not a URL', () => {
  const legacy: Route = { ...base, path: '/legacy-x', type: 'redirect', target: 'not a url' };

  it('migrates on a path-only change, and sends no target', async () => {
    await editing(legacy);
    await typeInto(input('path'), '/renamed');
    await save();
    await click(button('Migrate Route'));
    expect(state.migrate).toHaveBeenCalledWith({
      oldPath: '/legacy-x',
      newPath: '/renamed',
      domain: DOMAIN,
      updates: {},
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith('Route migrated from /legacy-x to /renamed');
  });

  it('saves other changes with the move, without the target', async () => {
    await editing(legacy);
    await typeInto(input('path'), '/renamed');
    await typeInto(input('cacheControl'), 'no-store');
    await save();
    await click(button('Migrate Route'));
    expect(state.migrate.mock.calls[0]?.[0]?.['updates']).toEqual({ cacheControl: 'no-store' });
    expect(state.update).not.toHaveBeenCalled();
  });
});

/** The credential guard's refusal of a route write. */
const refused = () =>
  new ApiError(
    400,
    'This route target carries credential-named parameters',
    {
      parameters: ['token'],
    },
    { code: 'ROUTE_TARGET_CREDENTIAL' },
  );

describe('a migration whose changes need the credential confirmation', () => {
  const tokenTarget: Route = {
    ...base,
    path: '/promo',
    type: 'redirect',
    target: 'https://example.net/landing?token=x',
  };
  it('asks BEFORE anything moves; cancelling leaves the route where it was', async () => {
    state.migrate.mockRejectedValueOnce(refused());
    await editing(tokenTarget);
    await typeInto(input('path'), '/promo-2');
    await typeInto(input('cacheControl'), 'no-store');
    await save();
    await click(button('Migrate Route'));
    expect(button('Migrate anyway')).toBeDefined();
    await click(button('Cancel'));
    expect(state.migrate).toHaveBeenCalledTimes(1);
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('confirming re-sends the same migration with the acknowledgement, in one write', async () => {
    state.migrate.mockRejectedValueOnce(refused());
    await editing(tokenTarget);
    await typeInto(input('path'), '/promo-2');
    await typeInto(input('cacheControl'), 'no-store');
    await save();
    await click(button('Migrate Route'));
    await click(button('Migrate anyway'));
    expect(state.migrate).toHaveBeenLastCalledWith({
      oldPath: '/promo',
      newPath: '/promo-2',
      domain: DOMAIN,
      updates: { cacheControl: 'no-store' },
      acknowledgeCredentialTarget: true,
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith(
      'Route migrated from /promo to /promo-2 and updated',
    );
  });
});

describe('a migration whose write domain cannot be resolved', () => {
  it('is reported as a toast, never an unhandled rejection', async () => {
    state.filters = {};
    await editing({ path: '/nodomain', type: 'redirect', target: 'https://example.net/' });
    await typeInto(input('path'), '/nodomain-2');
    await save();
    await click(button('Migrate Route'));
    expect(state.migrate).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/^Failed to migrate route: /));
  });
});

describe('converting and toggling in the route dialog', () => {
  it('a redirect converted to R2 sends the bucket and Force Download explicitly', async () => {
    await editing({ ...base, path: '/doc', type: 'redirect', target: 'https://example.net/' });
    await choose('Type', 'R2');
    await typeInto(input('target'), 'docs/a.pdf');
    await save();
    expect(sentData()).toEqual({
      type: 'r2',
      target: 'docs/a.pdf',
      bucket: 'files',
      forceDownload: false,
    });
  });

  it('a Force Download switched on and off again sends nothing', async () => {
    await editing({ ...base, path: '/brochure', type: 'r2', target: 'docs/brochure.pdf' });
    await click(document.getElementById('forceDownload'));
    await click(document.getElementById('forceDownload'));
    await save();
    expect(state.update).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith('No changes to save');
  });

  it('opens a route stored with a status code and bucket no write accepts today', async () => {
    await editing({
      path: '/old',
      type: 'redirect',
      target: 'https://example.net/',
      statusCode: 303,
      domain: DOMAIN,
    });
    await typeInto(input('cacheControl'), 'no-store');
    await save();
    expect(sentData()).toEqual({ cacheControl: 'no-store' });
  });
});

describe('stored values no write accepts are shown as what they are (v1.38.0)', () => {
  it('a status code outside 301/302/307/308 shows as stored; choosing 302 sends it', async () => {
    await editing({
      ...base,
      path: '/old',
      type: 'redirect',
      target: 'https://example.net/',
      statusCode: 303,
    });
    expect(document.getElementById('statusCode')?.textContent).toContain(
      '303 (not supported — choose another)',
    );
    expect(document.body.textContent).toContain('Stored as 303, which is not supported');
    await choose('Status Code', '302 (Temporary)');
    await save();
    expect(sentData()).toEqual({ statusCode: 302 });
  });

  it('a bucket outside the known list shows as stored; choosing files sends it', async () => {
    await editing({
      ...base,
      path: '/doc',
      type: 'r2',
      target: 'docs/a.pdf',
      bucket: 'retired-bucket',
    });
    expect(document.getElementById('bucket')?.textContent).toContain(
      'retired-bucket (not supported — choose another)',
    );
    await save();
    expect(state.update).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    await editing({
      ...base,
      path: '/doc',
      type: 'r2',
      target: 'docs/a.pdf',
      bucket: 'retired-bucket',
    });
    await choose('R2 Bucket', 'files');
    await save();
    expect(sentData()).toEqual({ bucket: 'files' });
  });

  it('a type change that would send an unsupported stored value is held until another is chosen', async () => {
    await editing({
      ...base,
      path: '/svc',
      type: 'proxy',
      target: 'https://origin.example.com/',
      statusCode: 303,
    });
    await choose('Type', 'Redirect');
    expect(button('Update').disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Stored as 303');
    await choose('Status Code', '301 (Permanent)');
    expect(button('Update').disabled).toBe(false);
    await save();
    expect(sentData()).toMatchObject({ type: 'redirect', statusCode: 301 });
  });
});

describe('a type change re-checks the untouched target for the new type (v1.38.0)', () => {
  it('an r2 object key kept as a redirect target is refused', async () => {
    await editing({ ...base, path: '/doc', type: 'r2', target: 'docs/a.pdf' });
    await choose('Type', 'Redirect');
    expect(document.body.textContent).toContain('Enter a valid absolute target URL before saving');
    expect(button('Update').disabled).toBe(true);
    await save();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('a URL kept as an r2 target is refused', async () => {
    await editing({ ...base, path: '/doc', type: 'redirect', target: 'https://example.net/a.pdf' });
    await choose('Type', 'R2');
    expect(document.body.textContent).toContain('Enter an R2 object key');
    expect(button('Update').disabled).toBe(true);
  });

  it('a mailto redirect kept as a proxy target is refused', async () => {
    await editing({ ...base, path: '/mail', type: 'redirect', target: 'mailto:team@example.com' });
    await choose('Type', 'Proxy');
    expect(document.body.textContent).toContain('A proxy target must be an http or https URL');
    expect(button('Update').disabled).toBe(true);
  });

  it('a proxy URL kept as a redirect target is accepted and sent', async () => {
    await editing({ ...base, path: '/svc', type: 'proxy', target: 'https://origin.example.com/' });
    await choose('Type', 'Redirect');
    expect(button('Update').disabled).toBe(false);
    await save();
    expect(sentData()).toMatchObject({ type: 'redirect', target: 'https://origin.example.com/' });
  });
});

describe('unreadable route records', () => {
  it('are listed flagged, with a Delete action and nothing else', async () => {
    state.invalidRoutes = [{ domain: DOMAIN, path: '/broken', invalid: true }];
    await editing({ ...base, path: '/x', type: 'redirect', target: 'https://example.net/' });
    await act(async () => button('Cancel').click());
    const row = document.body.querySelector('[data-testid="unreadable-route"]');
    expect(row?.textContent).toContain('/broken');
    expect(row?.textContent).toContain('Unreadable record');
    const buttons = [...(row?.querySelectorAll('button') ?? [])];
    expect(buttons.map(item => item.getAttribute('aria-label'))).toEqual([
      'Delete unreadable record /broken',
    ]);
    await click(buttons[0] ?? null);
    expect(document.body.textContent).toContain('Delete the unreadable record stored at exactly');
    await click(button('Delete'));
    // The exact-key recovery: never the ordinary, normalising delete
    expect(state.remove).toHaveBeenCalledWith({
      path: '/broken',
      domain: DOMAIN,
      recoverInvalid: true,
    });
  });

  it('a legacy key that does not round-trip is deleted by its exact key', async () => {
    state.invalidRoutes = [{ domain: DOMAIN, path: '/p?x', invalid: true }];
    await editing({ ...base, path: '/x', type: 'redirect', target: 'https://example.net/' });
    await act(async () => button('Cancel').click());
    await click(
      document.body.querySelector<HTMLElement>('[aria-label="Delete unreadable record /p?x"]'),
    );
    await click(button('Delete'));
    expect(state.remove).toHaveBeenCalledWith({
      path: '/p?x',
      domain: DOMAIN,
      recoverInvalid: true,
    });
  });

  it.each([
    ['a type filter', { type: 'redirect' }],
    ['an Active status filter', { enabled: true }],
    ['a Disabled status filter', { enabled: false }],
  ])('are not shown under %s: their type and state are unknown', async (_label, filter) => {
    state.invalidRoutes = [{ domain: DOMAIN, path: '/broken', invalid: true }];
    state.filters = { domain: DOMAIN, ...filter };
    await editing({ ...base, path: '/x', type: 'redirect', target: 'https://example.net/' });
    expect(document.body.querySelector('[data-testid="unreadable-route"]')).toBeNull();
  });
});
