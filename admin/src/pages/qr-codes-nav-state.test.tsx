// @vitest-environment happy-dom

/**
 * The QR page opened from "Save as QR Code" (v1.37.1): it opens on the domain
 * the navigation state names, then clears that state through the router while
 * the opened domain stays selected.
 */

import { SUPPORTED_DOMAINS } from '@bifrost/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QrQueryParams } from '@/lib/api-client';

const queries = vi.hoisted(() => vi.fn<(params: QrQueryParams) => void>());

vi.mock('@/hooks', () => ({
  useQrCodes: (params: QrQueryParams) => {
    queries(params);
    return {
      data: { items: [], meta: { total: 0, count: 0, offset: 0, limit: 25 } },
      isLoading: false,
      error: null,
    };
  },
  useCreateQr: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useUpdateQr: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useDeleteQr: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useDebounce: <T,>(value: T) => value,
  // The linked-route picker (v1.38.0); these forms never link a route
  useRoutes: () => ({
    data: { routes: [] },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn<() => void>(),
  }),
  useCreateRoute: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
}));
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    warning: vi.fn<(message: string) => void>(),
  },
}));
// The logo loaders pull in the API client, which reads its env at import time.
vi.mock('@/lib/qr-brand-logo', () => ({
  computeLogoAspectRatio: async () => null,
  fetchBrandLogo: async () => ({ dataUri: '', aspectRatio: 1 }),
}));

import { QrCodesPage } from './qr-codes';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{JSON.stringify(location)}</output>;
}

function routerLocation(): { pathname: string; search: string; state: unknown } {
  const text = document.querySelector('[data-testid="location"]')?.textContent;
  if (!text) throw new Error('no location rendered');
  return JSON.parse(text) as { pathname: string; search: string; state: unknown };
}

async function render(entry: { pathname: string; search?: string; state?: unknown }) {
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <QrCodesPage />
        <LocationProbe />
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  queries.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('QR page navigation-state domain', () => {
  const other = SUPPORTED_DOMAINS[1];

  it('opens on the named domain, then clears the state through the router', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    await render({ pathname: '/qr-codes', search: '?from=routes', state: { domain: other } });

    expect(queries.mock.calls[0]?.[0]).toMatchObject({ domain: other });
    // The opened domain stays selected after the state is cleared
    expect(queries.mock.lastCall?.[0]).toMatchObject({ domain: other });
    expect(routerLocation()).toMatchObject({
      pathname: '/qr-codes',
      search: '?from=routes',
      state: null,
    });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('clears a domain it does not offer too, and opens on the first one', async () => {
    await render({ pathname: '/qr-codes', state: { domain: 'unknown.example' } });
    expect(queries.mock.calls[0]?.[0]).toMatchObject({ domain: SUPPORTED_DOMAINS[0] });
    expect(routerLocation().state).toBeNull();
  });

  it('leaves state that names no domain alone', async () => {
    await render({ pathname: '/qr-codes', state: { other: 1 } });
    expect(queries.mock.calls[0]?.[0]).toMatchObject({ domain: SUPPORTED_DOMAINS[0] });
    expect(routerLocation().state).toEqual({ other: 1 });
  });
});
