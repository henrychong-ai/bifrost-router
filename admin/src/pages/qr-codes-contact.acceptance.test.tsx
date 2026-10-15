// @vitest-environment happy-dom

/**
 * The QR editor's contact card (vCard 3.0, v1.42.0), end to end with only the
 * data hooks mocked.
 */

import {
  type QRCode,
  QRDesignSchema,
  type QRVcardPayload,
  renderQrSvg,
  serializePayload,
  serializeVcard,
} from '@bifrost/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { svgToDataUri } from '@/lib/svg-to-png';

const DOMAIN = 'example.com';

const state = vi.hoisted(() => ({
  items: [] as QRCode[],
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
      invalid: [],
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
    data: { routes: [] },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn<() => void>(),
  }),
  useCreateRoute: () => ({ mutateAsync: vi.fn<() => Promise<void>>(), isPending: false }),
}));
vi.mock('sonner', () => ({ toast: toasts }));
// The logo loaders pull in the API client, which reads its env at import time.
vi.mock('@/lib/qr-brand-logo', () => ({
  computeLogoAspectRatio: async () => null,
  fetchBrandLogo: async () => ({ dataUri: '', aspectRatio: 1 }),
}));

import { QrCodesPage } from './qr-codes';

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

function field(id: string): HTMLInputElement {
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

function hasButton(text: string): boolean {
  return [...document.body.querySelectorAll('button')].some(
    item => item.textContent?.trim() === text,
  );
}

async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => element.click());
}

async function typeInto(id: string, value: string) {
  const element = field(id);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The combobox of the select labelled `label` (by its label or its own name). */
function combobox(label: string): HTMLElement {
  const named = document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  if (named) return named;
  const dialog = document.querySelector('[role="dialog"]');
  const labelNode = [...(dialog?.querySelectorAll('label') ?? [])].find(
    node => node.textContent?.trim() === label,
  );
  const trigger =
    labelNode?.parentElement?.querySelector<HTMLElement>('[role="combobox"]') ??
    labelNode?.parentElement?.parentElement?.querySelector<HTMLElement>('[role="combobox"]');
  if (!trigger) throw new Error(`no select ${label}`);
  return trigger;
}

async function openSelect(label: string) {
  const trigger = combobox(label);
  await act(async () =>
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    ),
  );
}

function option(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    node => node.textContent?.trim() === text,
  );
}

async function choose(label: string, text: string) {
  await openSelect(label);
  const item = option(text);
  expect(item, `option ${text}`).toBeDefined();
  await click(item ?? null);
}

/** The text a select shows: its selected option's label. */
function selected(label: string): string | undefined {
  return combobox(label).textContent?.trim();
}

/** The dialog's live preview image. */
function preview(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>('[role="dialog"] img[alt="QR code preview"]');
}

const previewOf = (content: string, design = QRDesignSchema.parse({})) =>
  svgToDataUri(renderQrSvg(content, design));

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

async function createDialog(type?: string) {
  await render();
  await click(button('New QR code'));
  if (type) await choose('Type', type);
}

async function openEdit(qr: QRCode) {
  state.items = [qr];
  await render();
  await click(document.body.querySelector('button[title="Edit"]'));
}

const created = () => state.createQr.mock.calls[0]?.[0]?.input;
const updated = () => state.updateQr.mock.calls[0]?.[0]?.input;

beforeEach(() => {
  state.items = [];
  state.createQr
    .mockReset()
    .mockImplementation(async ({ input }) => code({ id: String(input['id'] ?? 'generated') }));
  state.updateQr.mockReset().mockImplementation(async ({ id }) => code({ id }));
  for (const toast of Object.values(toasts)) toast.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('contact card form', () => {
  it('creates a vCard 3.0 card from every field, with a live preview and its size', async () => {
    await createDialog('Contact card');
    // No name yet: nothing to preview or save
    expect(document.body.textContent).toContain('Fill in the fields');
    expect(button('Create QR code').disabled).toBe(true);
    for (const [id, value] of Object.entries({
      'qr-first-name': 'Jane',
      'qr-surname': 'Doe',
      'qr-org': 'Example Widgets, Inc.',
      'qr-title': 'Head of Operations',
      'qr-phone-0': '+1 555 0100',
      'qr-email': 'jane.doe@example.com',
      'qr-vurl': 'example.com',
      'qr-street': 'Suite 12, 100 Main Street',
      'qr-city': 'Springfield',
      'qr-postcode': '12345',
      'qr-country': 'Exampleland',
    })) {
      await typeInto(id, value);
    }
    // The Reference follows the name
    expect(field('qr-id').value).toBe('jane-doe');
    // A second phone row defaults to the office line; a third can be retyped
    await click(button('Add phone'));
    await typeInto('qr-phone-1', '+1 555 0199');
    await click(button('Add phone'));
    await typeInto('qr-phone-2', '+1 555 0198');
    await choose('Phone 3 type', 'Fax');
    // Three is the most: the button goes
    expect(hasButton('Add phone')).toBe(false);
    const payload: QRVcardPayload = {
      firstName: 'Jane',
      surname: 'Doe',
      org: 'Example Widgets, Inc.',
      title: 'Head of Operations',
      phones: [
        { number: '+1 555 0100', type: 'work' },
        { number: '+1 555 0199', type: 'main' },
        { number: '+1 555 0198', type: 'fax' },
      ],
      email: 'jane.doe@example.com',
      url: 'example.com',
      address: {
        street: 'Suite 12, 100 Main Street',
        city: 'Springfield',
        postcode: '12345',
        country: 'Exampleland',
      },
    };
    const vcard = serializeVcard(payload);
    expect(preview()?.src).toBe(previewOf(vcard));
    expect(document.body.textContent).toContain(
      `vCard 3.0, ${new TextEncoder().encode(vcard).length} of 1024 bytes.`,
    );
    await click(button('Create QR code'));
    expect(created()).toMatchObject({ type: 'vcard', id: 'jane-doe', payload });
  });

  it('removes phone rows, keeping one to type into', async () => {
    await createDialog('Contact card');
    await typeInto('qr-first-name', 'Jane');
    await typeInto('qr-phone-0', '+1 555 0101');
    await click(button('Add phone'));
    await typeInto('qr-phone-1', '+1 555 0102');
    await click(document.querySelector('[aria-label="Remove phone 1"]'));
    expect(field('qr-phone-0').value).toBe('+1 555 0102');
    expect(document.getElementById('qr-phone-1')).toBeNull();
    await click(document.querySelector('[aria-label="Remove phone 1"]'));
    expect(field('qr-phone-0').value).toBe('');
    await click(button('Create QR code'));
    expect(created()?.['payload']).toEqual({ firstName: 'Jane' });
  });

  it('drops a blank phone row from the saved card, keeping the filled ones', async () => {
    await createDialog('Contact card');
    await typeInto('qr-first-name', 'Jane');
    await typeInto('qr-phone-0', '   ');
    await click(button('Add phone'));
    await typeInto('qr-phone-1', '+1 555 0102');
    await click(button('Create QR code'));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(created()?.['payload']).toEqual({
      firstName: 'Jane',
      phones: [{ number: '+1 555 0102', type: 'main' }],
    });
  });

  it('removing phone row 1 of 2 leaves the other row with its own number and type', async () => {
    await createDialog('Contact card');
    await typeInto('qr-first-name', 'Jane');
    await typeInto('qr-phone-0', '+1 555 0101');
    await choose('Phone 1 type', 'Mobile');
    await click(button('Add phone'));
    await typeInto('qr-phone-1', '+1 555 0102');
    await choose('Phone 2 type', 'Fax');
    await click(document.querySelector('[aria-label="Remove phone 1"]'));
    expect(field('qr-phone-0').value).toBe('+1 555 0102');
    expect(selected('Phone 1 type')).toBe('Fax');
    await click(button('Create QR code'));
    expect(created()?.['payload']).toMatchObject({
      phones: [{ number: '+1 555 0102', type: 'fax' }],
    });
  });

  it('warns while a contact card is over the 1 KB payload guard', async () => {
    await createDialog('Contact card');
    for (const id of ['qr-first-name', 'qr-surname', 'qr-org', 'qr-title', 'qr-street']) {
      await typeInto(id, ';'.repeat(128));
    }
    expect(document.body.textContent).toContain('Too long to save: shorten a field.');
  });

  it('edits a legacy card: its name and phone show in the new fields, saved as new fields', async () => {
    await openEdit(
      code({
        id: 'old-card',
        type: 'vcard',
        payload: { name: 'Jane Doe', phone: '+1 555 0100' },
      }),
    );
    expect(field('qr-first-name').value).toBe('Jane Doe');
    expect(field('qr-phone-0').value).toBe('+1 555 0100');
    await typeInto('qr-email', 'jane@example.com');
    await click(button('Save changes'));
    expect(updated()).toEqual({
      payload: {
        firstName: 'Jane Doe',
        phones: [{ number: '+1 555 0100', type: 'work' }],
        email: 'jane@example.com',
      },
    });
  });

  it('previews an untouched legacy card as stored, and the edited payload once changed', async () => {
    const legacy = { name: 'Jane Doe', phone: '+1 555 0100' };
    await openEdit(code({ id: 'old-card', type: 'vcard', payload: legacy }));
    const stored = serializePayload('vcard', legacy);
    expect(stored).toContain('TEL;TYPE=WORK,VOICE:');
    expect(preview()?.src).toBe(previewOf(stored));
    // A description edit leaves the payload as stored: still the stored preview
    await typeInto('qr-description', 'Front desk');
    expect(preview()?.src).toBe(previewOf(stored));
    // A payload edit previews what will be saved: the phone becomes PREF
    await typeInto('qr-email', 'jane@example.com');
    expect(preview()?.src).toBe(
      previewOf(
        'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane Doe;;;\r\nFN:Jane Doe\r\nTEL;TYPE=WORK,VOICE,PREF:+1 555 0100\r\nEMAIL;TYPE=INTERNET,WORK:jane@example.com\r\nEND:VCARD',
      ),
    );
  });

  it('saves a title edit of a stored card whose website holds a line break', async () => {
    await openEdit(
      code({ id: 'old-site', type: 'vcard', payload: { name: 'A', url: 'https://a.example\nB' } }),
    );
    expect(field('qr-vurl').value).toBe('https://a.exampleB');
    await typeInto('qr-title', 'Director');
    await click(button('Save changes'));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(updated()?.['payload']).toEqual({
      firstName: 'A',
      title: 'Director',
      url: 'https://a.exampleB',
    });
  });

  it('finds a card by name: the list search says so', async () => {
    await render();
    expect(
      document.querySelector('input[placeholder="Search description, id, or name…"]'),
    ).not.toBeNull();
  });
});
