// @vitest-environment happy-dom

/**
 * A folder with more direct entries than one storage listing materialises
 * says so: the item count shows a `+`, and a notice with a Narrow prefix
 * button replaces the old grey sentence. Only the data hooks are mocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { R2ListResponse } from '@/lib/api-client';

const state = vi.hoisted(() => ({ listing: undefined as unknown }));

const mutation = vi.hoisted(() => () => ({
  mutate: vi.fn<() => void>(),
  mutateAsync: vi.fn<() => Promise<void>>(),
  isPending: false,
}));

vi.mock('@/hooks', () => ({
  storageKeys: { all: ['storage'], objects: (...args: unknown[]) => ['storage', ...args] },
  useStorageBuckets: () => ({
    data: [{ name: 'files', access: 'read-write' }],
    isLoading: false,
  }),
  useStorageObjects: () => ({ data: state.listing, isLoading: false, error: null }),
  useDeleteObject: mutation,
  useMoveObject: mutation,
  usePurgeCache: mutation,
  useRenameObject: mutation,
  useRoutesByTarget: () => ({ data: undefined, isLoading: false }),
  useUpdateObjectMetadata: mutation,
  useUploadObject: mutation,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() },
}));

import { StoragePage } from './storage';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function listing(
  total: number,
  extra: { totalIsExact?: boolean; capped?: boolean } = {},
): R2ListResponse {
  const { totalIsExact, capped } = extra;
  return {
    objects: [],
    delimitedPrefixes: ['a/'],
    truncated: capped ?? false,
    ...(capped === undefined ? {} : { capped }),
    meta: {
      total,
      count: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
      ...(totalIsExact === undefined ? {} : { totalIsExact }),
    },
  };
}

async function renderPage(data: R2ListResponse) {
  state.listing = data;
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/storage']}>
          <StoragePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const notice = () => document.querySelector('[data-testid="storage-beyond-cap"]');

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    item => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('Storage page: folders beyond the listing cap', () => {
  it('shows the notice and a "+" count when the total is not exact', async () => {
    await renderPage(listing(1000, { totalIsExact: false, capped: true }));
    // An <output> element: a polite live status region.
    expect(notice()?.tagName).toBe('OUTPUT');
    expect(notice()?.textContent).toContain('More beyond the first 1,000.');
    expect(notice()?.textContent).toContain('holds more than 1,000 entries');
    expect(document.body.textContent).toContain('1000+ items');
  });

  it('still shows the notice from the older capped flag alone', async () => {
    await renderPage(listing(1000, { capped: true }));
    expect(notice()).not.toBeNull();
    expect(document.body.textContent).toContain('1000+ items');
  });

  it('shows no notice and no "+" when the total is exact', async () => {
    await renderPage(listing(12, { totalIsExact: true, capped: false }));
    expect(notice()).toBeNull();
    expect(document.body.textContent).toContain('12 items');
    expect(document.body.textContent).not.toContain('12+ items');
  });

  it('Narrow prefix puts the current folder back in the filter and focuses it', async () => {
    await renderPage(listing(1000, { totalIsExact: false, capped: true }));
    const filter = document.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. images/logos/"]',
    );
    if (!filter) throw new Error('no prefix filter');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(filter, 'elsewhere/');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(filter.value).toBe('elsewhere/');
    await act(async () => button('Narrow prefix').click());
    // At the bucket root the current folder is the empty prefix.
    expect(filter.value).toBe('');
    expect(document.activeElement).toBe(filter);
  });
});
