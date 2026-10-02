// @vitest-environment happy-dom

/**
 * The create form prefills the Reference from the URL's host until the user
 * edits the Reference, and stops following the URL from then on.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// The logo loaders pull in the API client, which reads its env at import time.
vi.mock('@/lib/qr-brand-logo', () => ({
  computeLogoAspectRatio: async () => null,
  fetchBrandLogo: async () => ({ dataUri: '', aspectRatio: 1 }),
}));

import { QrCodesPage } from './qr-codes';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
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

describe('QR create form Reference prefill', () => {
  it('follows the URL host while the Reference is untouched', async () => {
    await typeInto(input('qr-url'), 'https://www.example.com/listings');
    expect(input('qr-id').value).toBe('example-com');

    await typeInto(input('qr-url'), 'https://shop.example.net/');
    expect(input('qr-id').value).toBe('shop-example-net');
  });

  it('keeps the last suggestion when the URL is cleared', async () => {
    await typeInto(input('qr-url'), 'https://www.example.com/listings');
    await typeInto(input('qr-url'), '');
    expect(input('qr-id').value).toBe('example-com');
  });

  it('stops following the URL once the Reference is edited', async () => {
    await typeInto(input('qr-url'), 'https://www.example.com/listings');
    await typeInto(input('qr-id'), 'my-code');
    await typeInto(input('qr-url'), 'https://shop.example.net/');
    expect(input('qr-id').value).toBe('my-code');
  });
});
