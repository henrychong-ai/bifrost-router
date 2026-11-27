// @vitest-environment happy-dom

/**
 * The route dialog's link-preview section end to end (v1.48.0), with only the
 * data hooks mocked: the section shows for a single-file r2 route, an edit
 * sends only the changed preview field, a field error holds the save, the
 * live card follows the fields and the dashboard's read of the file, and a
 * create sends the preview fields that hold a value.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import { usePreviewBuckets } from '@/lib/preview-buckets.fixture';
import type { Route } from '@/lib/schemas';

const state = vi.hoisted(() => ({
  update: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  create: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  migrate: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  remove: vi.fn<(variables: Record<string, unknown>) => Promise<unknown>>(),
  invalidRoutes: [] as Array<{ domain: string; path: string; invalid: true }>,
  filters: { domain: 'example.com' } as Record<string, unknown>,
  // The dashboard's read of the route's file: what useObjectMeta answers
  meta: { data: undefined, error: null } as { data: unknown; error: unknown },
  metaCalls: [] as unknown[][],
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
  // The route form's read of an r2 file for its link preview (v1.48.0): unconfirmed
  useObjectMeta: (...args: unknown[]) => {
    state.metaCalls.push(args);
    return args[0] && args[1] ? state.meta : { data: undefined, error: null };
  },
  useTransferRoute: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
  useCreateQr: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
  useQrCodes: () => ({ data: undefined }),
  useDebounce: <T,>(value: T) => value,
  usePrefetchAllDomainRoutes: () => undefined,
  // The pending-route store (v1.41.1): nothing written here, so listings show as they are
  usePendingRouteView: () => ({
    version: 0,
    project: (list: unknown) => list,
    projectRows: (rows: unknown) => rows,
  }),
  usePendingRouteAdmission: () => ({ version: 0, isPending: () => false }),
}));
vi.mock('@/context', () => ({
  SUPPORTED_DOMAINS: ['example.com'],
  useRoutesFilters: () => ({ filters: state.filters, setFilters: vi.fn<() => void>() }),
}));
vi.mock('@/components/link-preview', () => ({ LinkPreview: () => null }));
vi.mock('sonner', () => ({ toast: toasts }));

import { RoutesPage } from './routes';

usePreviewBuckets();

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
  state.meta = { data: undefined, error: null };
  state.metaCalls = [];
  toasts.success.mockReset();
  toasts.error.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const file: Route = {
  ...base,
  path: '/report',
  type: 'r2',
  target: 'docs/report.pdf',
  bucket: 'files',
};
const withPreview: Route = {
  ...file,
  previewTitle: 'Annual report',
  previewDescription: 'The year in numbers',
  previewImageBucket: 'assets',
  previewImageKey: 'previews/report.jpg',
  previewImageWidth: 1200,
  previewImageHeight: 630,
};

const section = () => document.querySelector('section[aria-labelledby="link-preview-heading"]');
const card = () =>
  document.querySelector('section[aria-labelledby="link-preview-card-heading"]')?.textContent ?? '';
const textarea = (id: string) => document.getElementById(id) as HTMLTextAreaElement;

async function typeIntoArea(element: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the route dialog link-preview section (v1.48.0)', () => {
  it('shows the stored preview and sends only the changed field', async () => {
    await editing(withPreview);
    expect(section()).not.toBeNull();
    expect(input('previewTitle').value).toBe('Annual report');
    await typeIntoArea(textarea('previewDescription'), 'Updated');
    await save();
    expect(sentData()).toEqual({ previewDescription: 'Updated' });
  });

  it('is not shown for a redirect or a wildcard r2 route', async () => {
    await editing({ ...base, path: '/go', type: 'redirect', target: 'https://example.com/' });
    expect(section()).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
    await editing({ ...file, path: '/docs/*', target: 'docs/' });
    expect(section()).toBeNull();
  });

  it('an invalid video size blocks saving; nothing is sent', async () => {
    await editing(withPreview);
    await typeInto(input('previewVideoWidth'), '1920');
    expect(button('Update').disabled).toBe(true);
    await save();
    expect(state.update).not.toHaveBeenCalled();
    await typeInto(input('previewVideoHeight'), '1080');
    expect(button('Update').disabled).toBe(false);
    await save();
    expect(sentData()).toEqual({ previewVideoWidth: 1920, previewVideoHeight: 1080 });
  });

  it('blanking the stored title clears the whole preview', async () => {
    await editing(withPreview);
    await typeInto(input('previewTitle'), '');
    await save();
    expect(sentData()).toEqual({ previewTitle: '' });
  });

  it('a route turned into a redirect clears its stored preview', async () => {
    await editing(withPreview);
    await choose('Type', 'Redirect');
    await typeInto(input('target'), 'https://example.com/');
    await save();
    expect(sentData()).toMatchObject({ type: 'redirect', previewTitle: '' });
  });

  it('the live card shows the stored card, follows the fields, and says why none is sent', async () => {
    await editing(withPreview);
    expect(card()).toContain('Annual report');
    // Not yet confirmed by the read of the file
    expect(card()).toContain('not been confirmed');
    await typeInto(input('previewTitle'), 'Renamed');
    expect(card()).toContain('Renamed');
    await typeInto(input('previewTitle'), '');
    expect(card()).toContain('No card will be sent. Add a title.');
  });

  it('reads the file once, with no retry and no refetch on focus, and believes its answer', async () => {
    state.meta = { data: { httpMetadata: { contentType: 'application/pdf' } }, error: null };
    await editing(withPreview);
    expect(state.metaCalls).toContainEqual([
      'files',
      'docs/report.pdf',
      { retry: false, refetchOnWindowFocus: false },
    ]);
    expect(card()).not.toContain('not been confirmed');
  });

  it('a file the read found missing gets the no-card line', async () => {
    state.meta = { data: undefined, error: new ApiError(404, 'Not found') };
    await editing(withPreview);
    expect(card()).toContain('No card will be sent. The file was not found in its bucket');
  });

  it('a file stored as an image gets the image note, by its stored type', async () => {
    state.meta = { data: { httpMetadata: { contentType: 'image/png' } }, error: null };
    await editing({ ...withPreview, target: 'docs/report' });
    expect(document.querySelector('[role="note"]')?.textContent).toContain('This file is an image');
  });

  it('a target that cannot be an object key is not read', async () => {
    await editing({ ...file, target: 'https://example.com/a.pdf' });
    expect(state.metaCalls.every(([bucket, key]) => bucket === '' && key === '')).toBe(true);
  });
});

/** The Routes page with the create dialog open. */
async function creating() {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/routes']}>
          <RoutesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await click(
    [...document.body.querySelectorAll('button')].find(
      item => item.textContent?.trim() === 'New Route',
    ) ?? null,
  );
  await typeInto(input('path'), '/report');
  await choose('Type', 'R2');
  await typeInto(input('target'), 'docs/report.pdf');
}

describe('creating a route with a link preview (v1.48.0)', () => {
  it('sends the preview fields that hold a value', async () => {
    await creating();
    await typeInto(input('previewTitle'), 'Annual report');
    await typeInto(input('previewVideoWidth'), '');
    await click(button('Create'));
    expect(state.create).toHaveBeenCalledTimes(1);
    const sent = state.create.mock.calls[0]?.[0]?.['data'];
    expect(sent).toMatchObject({ path: '/report', type: 'r2', previewTitle: 'Annual report' });
    expect(sent).not.toHaveProperty('previewDescription');
    expect(sent).not.toHaveProperty('previewVideoWidth');
  });

  it('a description and an image without a title is blocked; nothing is sent', async () => {
    await creating();
    await typeIntoArea(textarea('previewDescription'), 'About');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Add a title');
    expect(button('Create').disabled).toBe(true);
    await click(button('Create'));
    expect(state.create).not.toHaveBeenCalled();
  });
});
