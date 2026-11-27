// @vitest-environment happy-dom

/**
 * The Storage edit dialog for a route's link-preview image (v1.48.0): the
 * associated routes name a route that shows the file as its preview image,
 * and Replace File warns before a file is picked that the file cannot be
 * replaced (the server's refusal stays the final word). Only the data hooks
 * are mocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { R2ListResponse } from '@/lib/api-client';
import type { RouteWithDomain } from '@/lib/schemas';

const state = vi.hoisted(() => ({
  routes: [] as RouteWithDomain[],
}));

const mutation = vi.hoisted(() => () => ({
  mutate: vi.fn<() => void>(),
  mutateAsync: vi.fn<() => Promise<void>>(),
  isPending: false,
}));

const listing: R2ListResponse = {
  objects: [
    {
      key: 'previews/report.jpg',
      size: 1024,
      etag: 'etag-1',
      uploaded: '2026-11-01T00:00:00.000Z',
      httpMetadata: { contentType: 'image/jpeg' },
    },
  ],
  delimitedPrefixes: [],
  truncated: false,
  meta: { total: 1, count: 1, offset: 0, limit: 50, hasMore: false },
};

vi.mock('@/hooks', () => ({
  storageKeys: { all: ['storage'], objects: (...args: unknown[]) => ['storage', ...args] },
  useStorageBuckets: () => ({
    data: [{ name: 'assets', access: 'read-write' }],
    isLoading: false,
  }),
  useStorageObjects: () => ({ data: listing, isLoading: false, error: null }),
  useDeleteObject: mutation,
  useMoveObject: mutation,
  usePurgeCache: mutation,
  useRenameObject: mutation,
  useRoutesByTarget: () => ({ data: state.routes, isLoading: false }),
  useUpdateObjectMetadata: mutation,
  useUploadObject: mutation,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() },
}));

import { StoragePage } from './storage';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** The Storage page with the edit dialog open on the listed image. */
async function openDialog(routes: RouteWithDomain[]) {
  state.routes = routes;
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
  const row = [...document.querySelectorAll('tr')].find(item =>
    item.textContent?.includes('report.jpg'),
  );
  if (!row) throw new Error('no object row');
  await act(async () => row.click());
}

const warning = () => document.querySelector('[data-testid="replace-preview-image-warning"]');
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
/** The usage badges of the associated routes, by their text. */
const badges = () =>
  [...document.querySelectorAll('[role="dialog"] button span')]
    .map(node => node.textContent?.trim())
    .filter(text => text === 'preview image' || text === 'r2');

const servingRoute: RouteWithDomain = {
  domain: 'links.example.com',
  path: '/photo',
  type: 'r2',
  target: 'previews/report.jpg',
  bucket: 'assets',
  createdAt: 1,
  updatedAt: 1,
};
const previewRoute: RouteWithDomain = {
  domain: 'links.example.com',
  path: '/report',
  type: 'r2',
  target: 'docs/report.pdf',
  bucket: 'files',
  createdAt: 1,
  updatedAt: 1,
  usage: 'preview-image',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('Storage edit dialog: a route preview image (v1.48.0)', () => {
  it('names the route that shows the file as its preview image, and warns before Replace', async () => {
    await openDialog([servingRoute, previewRoute]);
    expect(dialogText()).toContain('/report');
    expect(badges()).toEqual(['r2', 'preview image']);
    expect(warning()?.getAttribute('role')).toBe('note');
    expect(warning()?.textContent).toContain(
      'A route uses this file as its link-preview image, so it cannot be replaced.',
    );
  });

  it('warns when the route that serves the file also shows it as its preview image', async () => {
    await openDialog([{ ...servingRoute, usage: 'file', previewImage: true }]);
    expect(warning()).not.toBeNull();
    // It serves the file, so it is listed by its type
    expect(badges()).toEqual(['r2']);
  });

  it('gives no warning for a file only served by routes', async () => {
    await openDialog([servingRoute]);
    expect(warning()).toBeNull();
    expect(dialogText()).toContain('/photo');
  });
});
