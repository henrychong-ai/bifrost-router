// @vitest-environment happy-dom

/**
 * The QR editor end to end, with only the data hooks mocked (v1.38.0):
 * linking a code to an existing or a new route, the link-naming advice, and
 * edits that send only what changed.
 */

import { type QRCode, QRDesignSchema } from '@bifrost/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import type { Route } from '@/lib/schemas';

const DOMAIN = 'example.com';

const state = vi.hoisted(() => ({
  items: [] as QRCode[],
  routes: [] as Route[],
  createQr:
    vi.fn<(variables: { input: Record<string, unknown>; domain: string }) => Promise<QRCode>>(),
  updateQr:
    vi.fn<
      (variables: { id: string; input: Record<string, unknown>; domain: string }) => Promise<QRCode>
    >(),
  createRoute:
    vi.fn<(variables: { data: Record<string, unknown>; domain: string }) => Promise<Route>>(),
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
  warning: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>(),
}));

vi.mock('@/hooks', () => ({
  useQrCodes: () => ({
    data: {
      items: state.items,
      meta: {
        total: state.items.length,
        count: state.items.length,
        offset: 0,
        limit: 25,
        hasMore: false,
      },
    },
    isLoading: false,
    error: null,
  }),
  useCreateQr: () => ({ mutateAsync: state.createQr, isPending: false }),
  useUpdateQr: () => ({ mutateAsync: state.updateQr, isPending: false }),
  useDeleteQr: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useDebounce: <T,>(value: T) => value,
  useRoutes: () => ({
    data: { routes: state.routes },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn<() => void>(),
  }),
  useCreateRoute: () => ({ mutateAsync: state.createRoute, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: toasts }));
// The logo loaders pull in the API client, which reads its env at import time.
vi.mock('@/lib/qr-brand-logo', () => ({
  computeLogoAspectRatio: async () => null,
  fetchBrandLogo: async () => ({ dataUri: '', aspectRatio: 1 }),
}));

import { QrCodesPage } from './qr-codes';

const route = (path: string): Route => ({
  path,
  type: 'redirect',
  target: 'https://example.net/landing',
  createdAt: 1,
  updatedAt: 1,
  domain: DOMAIN,
});

function code(overrides: Partial<QRCode> = {}): QRCode {
  return {
    id: 'saved-code',
    domain: DOMAIN,
    type: 'url',
    payload: { url: 'https://example.net/' },
    design: QRDesignSchema.parse({}),
    createdAt: 1,
    updatedAt: 2,
    createdBy: 'test',
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

function button(text: string | RegExp): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(item =>
    typeof text === 'string'
      ? item.textContent?.trim() === text
      : text.test(item.textContent ?? ''),
  );
  if (!found) throw new Error(`no button ${String(text)}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function typeInto(element: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openEdit() {
  const edit = document.body.querySelector<HTMLButtonElement>('button[title="Edit"]');
  if (!edit) throw new Error('no edit button');
  await click(edit);
}

async function render() {
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
}

beforeEach(() => {
  state.items = [];
  state.routes = [route('/summer-sale'), route('/winter-offer')];
  state.createQr
    .mockReset()
    .mockImplementation(async ({ input: body }) => code({ id: String(body['id'] ?? 'generated') }));
  state.updateQr.mockReset().mockImplementation(async ({ id }) => code({ id }));
  state.createRoute.mockReset().mockImplementation(async ({ data }) => route(String(data['path'])));
  for (const toast of Object.values(toasts)) toast.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('linking a QR code to a route', () => {
  beforeEach(async () => {
    await render();
    await click(button(/New QR code/));
    const toggle = document.getElementById('qr-link-route');
    if (!toggle) throw new Error('no link switch');
    await click(toggle);
  });

  it('links an existing route found with the shared matcher, and encodes its short URL', async () => {
    // Separators and word order do not matter
    await typeInto(input('qr-route-search'), 'Sale_Summer');
    expect(button('/summer-sale')).toBeTruthy();
    expect(() => button('/winter-offer')).toThrow('no button /winter-offer');
    await click(button('/summer-sale'));
    expect(input('qr-url').value).toBe(`https://${DOMAIN}/summer-sale`);
    expect(input('qr-url').readOnly).toBe(true);

    await click(button('Create QR code'));
    expect(state.createRoute).not.toHaveBeenCalled();
    const sent = state.createQr.mock.calls[0]?.[0];
    expect(sent?.domain).toBe(DOMAIN);
    expect(sent?.input).toMatchObject({
      type: 'url',
      payload: { url: `https://${DOMAIN}/summer-sale` },
      linkedRoute: { domain: DOMAIN, path: '/summer-sale' },
    });
    // A linked code keeps one reference across retries: generated up front
    expect(sent?.input['id']).toMatch(/^[0-9a-f]{12}$/);
  });

  it('creates a new 302 route first, advises on its name, and never creates it twice', async () => {
    await click(button('New route'));
    await typeInto(input('qr-route-path'), 'Summer Sale Final');
    // Advice only, never a block: the version word is flagged
    expect(document.body.textContent).toContain('Remove "final"');
    await typeInto(input('qr-route-target'), 'https://example.net/summer');
    state.createQr.mockRejectedValueOnce(new Error('network down'));

    await click(button('Create QR code'));
    expect(state.createRoute).toHaveBeenCalledTimes(1);
    expect(state.createRoute.mock.calls[0]?.[0]).toMatchObject({
      domain: DOMAIN,
      data: {
        path: '/summer-sale-final',
        type: 'redirect',
        target: 'https://example.net/summer',
        statusCode: 302,
        preserveQuery: true,
      },
    });
    // The QR save failed: the route is kept and reported
    expect(toasts.error.mock.calls.at(-1)?.[0]).toContain('was created');

    // Retry saves only the code, against the route already created
    await click(button('Create QR code'));
    expect(state.createRoute).toHaveBeenCalledTimes(1);
    expect(state.createQr).toHaveBeenCalledTimes(2);
    expect(state.createQr.mock.calls[1]?.[0].input).toMatchObject({
      linkedRoute: { domain: DOMAIN, path: '/summer-sale-final' },
    });
    expect(state.createQr.mock.calls[1]?.[0].input['id']).toBe(
      state.createQr.mock.calls[0]?.[0].input['id'],
    );
  });

  it('refuses a new route without a web target, creating nothing', async () => {
    await click(button('New route'));
    await typeInto(input('qr-route-path'), '/autumn');
    await typeInto(input('qr-route-target'), 'ftp://example.net/');
    await click(button('Create QR code'));
    expect(state.createRoute).not.toHaveBeenCalled();
    expect(state.createQr).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      'Enter a valid route path and an HTTP or HTTPS target.',
    );
  });

  it('notes another code that already links the route', async () => {
    state.items = [
      code({ id: 'first-print', linkedRoute: { domain: DOMAIN, path: '/summer-sale' } }),
    ];
    await typeInto(input('qr-route-search'), 'summer');
    await click(button('/summer-sale'));
    expect(document.body.textContent).toContain('“first-print” already links to this route');
  });
});

describe('editing a QR code', () => {
  /** Saved under earlier limits: a 120-character description and 12 tags. */
  const legacy = code({
    description: 'd'.repeat(120),
    tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`),
  });

  beforeEach(async () => {
    state.items = [legacy];
    await render();
  });

  it('makes no request when nothing changed', async () => {
    await openEdit();
    await click(button('Save changes'));
    expect(state.updateQr).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith('No changes to save');
  });

  it('sends only the changed field of a record over today’s limits', async () => {
    await openEdit();
    await typeInto(input('qr-url'), 'https://example.net/new');
    await click(button('Save changes'));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(state.updateQr).toHaveBeenCalledWith({
      id: 'saved-code',
      domain: DOMAIN,
      input: { payload: { url: 'https://example.net/new' } },
    });
  });

  it('still refuses an over-limit value the user sets', async () => {
    await openEdit();
    await typeInto(input('qr-description'), 'e'.repeat(101));
    await click(button('Save changes'));
    expect(state.updateQr).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalled();
  });

  it('closes and says so when the code was deleted elsewhere', async () => {
    state.updateQr.mockRejectedValueOnce(
      new ApiError(404, 'QR code not found: saved-code', undefined, { code: 'QR_NOT_FOUND' }),
    );
    await openEdit();
    await typeInto(input('qr-description'), 'Front desk');
    await click(button('Save changes'));
    expect(toasts.info).toHaveBeenCalledWith('QR code saved-code was already deleted');
    expect(() => button('Save changes')).toThrow('no button Save changes');
  });
});
