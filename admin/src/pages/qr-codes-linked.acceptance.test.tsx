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
  invalid: [] as Array<{ domain: string; id: string; invalid: true }>,
  routes: [] as Route[],
  createQr:
    vi.fn<
      (variables: {
        input: Record<string, unknown>;
        domain: string;
        afterUncertainAnswer?: boolean;
      }) => Promise<QRCode>
    >(),
  updateQr:
    vi.fn<
      (variables: {
        id: string;
        input: Record<string, unknown>;
        domain: string;
        createdAt?: number;
      }) => Promise<QRCode>
    >(),
  deleteQr: vi.fn<(variables: { id: string; domain: string; createdAt?: number }) => void>(),
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
      invalid: state.invalid,
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
  useDeleteQr: () => ({ mutate: state.deleteQr, isPending: false }),
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
  state.invalid = [];
  state.deleteQr.mockReset();
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
      // The incarnation the dialog edited, for a QR_NOT_FOUND tombstone
      createdAt: 1,
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

  it('shows the server message for an unreadable record and keeps the dialog open', async () => {
    state.updateQr.mockRejectedValueOnce(
      new ApiError(
        409,
        'This QR code is stored in a shape that cannot be read. Delete it and create it again.',
        undefined,
        { code: 'QR_RECORD_INVALID' },
      ),
    );
    await openEdit();
    await typeInto(input('qr-description'), 'Front desk');
    await click(button('Save changes'));
    expect(toasts.error).toHaveBeenCalledWith(
      'This QR code is stored in a shape that cannot be read. Delete it and create it again.',
    );
    expect(toasts.info).not.toHaveBeenCalled();
    expect(button('Save changes')).toBeTruthy();
  });

  it('never rewrites stored tags it cannot show as they are, on a description edit', async () => {
    state.items = [code({ tags: ['a,b', 'c'] })];
    await act(async () => root?.unmount());
    await render();
    await openEdit();
    await typeInto(input('qr-description'), 'Front desk');
    await click(button('Save changes'));
    expect(state.updateQr.mock.calls[0]?.[0].input).toEqual({ description: 'Front desk' });
  });
});

describe('a linked code whose route the picker does not hold', () => {
  it.each([
    ['deleted, or beyond the newest routes loaded', () => [route('/winter-offer')]],
    ['while the routes have not loaded', () => []],
  ])('edits other fields when its route is %s', async (_label, routes) => {
    state.routes = routes();
    state.items = [
      code({
        payload: { url: `https://${DOMAIN}/gone` },
        linkedRoute: { domain: DOMAIN, path: '/gone' },
      }),
    ];
    await render();
    await openEdit();
    await typeInto(input('qr-description'), 'Front desk');
    await click(button('Save changes'));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(state.updateQr.mock.calls[0]?.[0].input).toEqual({ description: 'Front desk' });
  });
});

describe('a new linked route kept when the code is gone', () => {
  it('reports the created route with View route when the edit finds the code deleted', async () => {
    state.items = [code()];
    await render();
    await openEdit();
    const toggle = document.getElementById('qr-link-route');
    if (!toggle) throw new Error('no link switch');
    await click(toggle);
    await click(button('New route'));
    await typeInto(input('qr-route-path'), '/autumn');
    await typeInto(input('qr-route-target'), 'https://example.net/autumn');
    state.updateQr.mockRejectedValueOnce(
      new ApiError(404, 'QR code not found: saved-code', undefined, { code: 'QR_NOT_FOUND' }),
    );
    await click(button('Save changes'));
    expect(state.createRoute).toHaveBeenCalledTimes(1);
    expect(toasts.info).toHaveBeenCalledWith('QR code saved-code was already deleted');
    const [message, options] = (toasts.error.mock.calls.at(-1) ?? []) as unknown as [
      string,
      { action?: { label?: string } } | undefined,
    ];
    expect(message).toContain(`Route https://${DOMAIN}/autumn was created`);
    expect(options?.action?.label).toBe('View route');
  });
});

/** The last error toast: its message and options. */
const lastError = () =>
  (toasts.error.mock.calls.at(-1) ?? []) as unknown as [
    string,
    { action?: { label?: string } } | undefined,
  ];

describe('a save failure after the editor created the linked route (v1.38.0)', () => {
  beforeEach(async () => {
    await render();
    await click(button(/New QR code/));
    const toggle = document.getElementById('qr-link-route');
    if (!toggle) throw new Error('no link switch');
    await click(toggle);
    await click(button('New route'));
    await typeInto(input('qr-route-path'), '/autumn');
    await typeInto(input('qr-route-target'), 'https://example.net/autumn');
  });

  it.each([
    [new ApiError(400, 'Tags must be at most 10')],
    [
      new ApiError(409, 'QR code already exists: autumn-code', undefined, {
        code: 'QR_ALREADY_EXISTS',
      }),
    ],
    [
      new ApiError(
        409,
        'This QR code is stored in a shape that cannot be read. Delete it and create it again.',
        undefined,
        { code: 'QR_RECORD_INVALID' },
      ),
    ],
  ])('shows the server answer %#, keeping the route with View route', async error => {
    state.createQr.mockRejectedValueOnce(error);
    await click(button('Create QR code'));
    const [message, options] = lastError();
    expect(message).toContain(`Route https://${DOMAIN}/autumn was created`);
    expect(message).toContain(`the QR code was not saved: ${error.message}`);
    expect(options?.action?.label).toBe('View route');
  });

  it('says the save could not be confirmed when no answer arrived, and marks the retry', async () => {
    state.createQr.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await click(button('Create QR code'));
    expect(lastError()[0]).toContain('the QR save could not be confirmed');
    expect(state.createQr.mock.calls[0]?.[0]).toMatchObject({ afterUncertainAnswer: false });
    // The retry of the same id says its first answer was uncertain, so a 409
    // for its own code is taken as that earlier save
    await click(button('Create QR code'));
    expect(state.createQr.mock.calls[1]?.[0]).toMatchObject({ afterUncertainAnswer: true });
    expect(state.createQr.mock.calls[1]?.[0].input['id']).toBe(
      state.createQr.mock.calls[0]?.[0].input['id'],
    );
    expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/^QR code created: /));
  });

  it('a retry after a certain refusal is not marked', async () => {
    state.createQr.mockRejectedValueOnce(new ApiError(400, 'Tags must be at most 10'));
    await click(button('Create QR code'));
    await click(button('Create QR code'));
    expect(state.createQr.mock.calls[1]?.[0]).toMatchObject({ afterUncertainAnswer: false });
  });
});

describe('unreadable QR records', () => {
  it('are listed flagged, with a Delete action and nothing else', async () => {
    state.invalid = [{ domain: DOMAIN, id: 'broken-code', invalid: true }];
    await render();
    const row = document.body.querySelector('[data-testid="unreadable-qr"]');
    expect(row?.textContent).toContain('broken-code');
    expect(row?.textContent).toContain('Unreadable record');
    const buttons = [...(row?.querySelectorAll('button') ?? [])];
    expect(buttons.map(item => item.getAttribute('aria-label'))).toEqual([
      'Delete unreadable record broken-code',
    ]);
    await click(buttons[0] as HTMLButtonElement);
    await click(button('Delete'));
    expect(state.deleteQr.mock.calls[0]?.[0]).toEqual({
      id: 'broken-code',
      domain: DOMAIN,
      createdAt: undefined,
    });
  });
});
