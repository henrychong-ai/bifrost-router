// @vitest-environment happy-dom

/**
 * A create form whose domain has a brand preset with a logo: the preset's
 * colours are the starting design, its logo loads after mount, and submission
 * waits for that load. The template ships no presets, so one is supplied here.
 */

import type { QrBrandPreset } from '@bifrost/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preset = vi.hoisted(
  (): QrBrandPreset => ({
    id: 'acme',
    label: 'Acme',
    fg: '#112233',
    bg: '#fefefe',
    logoAssetKey: 'logos/acme.png',
    domains: [],
  }),
);
const logo = vi.hoisted(() => Promise.withResolvers<{ dataUri: string; aspectRatio: number }>());
const fetchBrandLogo = vi.hoisted(() =>
  vi.fn<(key: string) => Promise<{ dataUri: string; aspectRatio: number }>>(() => logo.promise),
);

vi.mock('@bifrost/shared', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  QR_BRAND_PRESETS: [preset],
  deriveBrandForDomain: () => preset,
}));
vi.mock('@/hooks', () => ({
  useQrCodes: () => ({
    data: { items: [], meta: { total: 0, count: 0, offset: 0, limit: 25 } },
    isLoading: false,
    error: null,
  }),
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
vi.mock('@/lib/qr-brand-logo', () => ({
  computeLogoAspectRatio: async () => null,
  fetchBrandLogo,
}));

import { QrCodesPage } from './qr-codes';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

function submitButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find(b =>
    /Create QR code|Preparing logo/.test(b.textContent ?? ''),
  );
  if (!button) throw new Error('no submit button');
  return button;
}

async function typeInto(element: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <QrCodesPage />
      </MemoryRouter>,
    );
  });
  const open = [...document.body.querySelectorAll('button')].find(button =>
    button.textContent?.includes('New QR code'),
  );
  await act(async () => open?.click());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('QR create form with a branded domain', () => {
  it('starts from the preset colours and waits for its logo before submitting', async () => {
    expect(input('qr-fg').value).toBe('#112233');
    expect(input('qr-bg').value).toBe('#fefefe');
    expect(fetchBrandLogo).toHaveBeenCalledWith('logos/acme.png');

    await typeInto(input('qr-url'), 'https://www.example.com/');
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      logo.resolve({ dataUri: 'data:image/png;base64,AAAA', aspectRatio: 1 });
      await logo.promise;
    });

    expect(submitButton().disabled).toBe(false);
  });
});
