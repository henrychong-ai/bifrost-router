// @vitest-environment happy-dom

/**
 * The triage dialog's per-item state: unsaved edits and loaded attachments
 * belong to the item they were made for, and never carry over to the next.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackItem } from '@bifrost/shared';

const mocks = vi.hoisted(() => ({ item: null as unknown }));

vi.mock('@/hooks/use-feedback', () => ({
  useFeedbackItem: () => ({ data: mocks.item, isLoading: false }),
  useTriageFeedback: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteFeedback: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/api-client', () => ({
  api: {
    feedback: {
      attachment: vi.fn(async (_id: string, key: string) =>
        key.endsWith('.json')
          ? new Blob([
              JSON.stringify({ console: [{ level: 'error', message: 'boom' }], network: [] }),
            ])
          : new Blob(['png'], { type: 'image/png' }),
      ),
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FeedbackDetailDialog } from './feedback-detail-dialog';

function itemFixture(overrides: Partial<FeedbackItem>): FeedbackItem {
  return {
    id: '0190abcd-0000-7000-8000-000000000000',
    shortId: 'F-1',
    type: 'bug',
    priority: 2,
    status: 'new',
    title: 'Request failed',
    description: 'Creating a QR code fails',
    steps: null,
    expected: null,
    actual: null,
    context: null,
    screenshotKeys: [],
    captureKey: null,
    labels: null,
    area: null,
    assignee: null,
    triageNotes: null,
    linkedPr: null,
    externalRef: null,
    submitterEmail: 'user@example.com',
    submitterName: 'User',
    createdAt: '2026-07-24T12:45:00.000Z',
    updatedAt: '2026-07-24T12:45:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

const ITEM_A = itemFixture({
  id: '0190abcd-0000-7000-8000-00000000000a',
  shortId: 'F-1',
  area: 'alpha',
  screenshotKeys: ['shot.png'],
  captureKey: 'capture.json',
});
const ITEM_B = itemFixture({
  id: '0190abcd-0000-7000-8000-00000000000b',
  shortId: 'F-2',
  area: 'beta',
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** The text input that follows the label with this text. */
function inputAfterLabel(label: string): HTMLInputElement {
  const input = [...document.body.querySelectorAll('input')].find(
    element => element.previousElementSibling?.textContent === label,
  );
  if (!input) throw new Error(`no input labelled ${label}`);
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render(item: FeedbackItem, open = true) {
  mocks.item = item;
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<FeedbackDetailDialog id={item.id} open={open} onOpenChange={() => undefined} />);
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('triage dialog per-item state', () => {
  it('drops unsaved edits when another item loads', async () => {
    await render(ITEM_A);
    await typeInto(inputAfterLabel('Area'), 'edited');
    expect(inputAfterLabel('Area').value).toBe('edited');

    await render(ITEM_B);

    expect(inputAfterLabel('Area').value).toBe('beta');
  });

  it("shows only the loaded item's screenshots and capture bundle", async () => {
    await render(ITEM_A);
    expect(document.body.querySelectorAll('img[alt="screenshot"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Console & network');

    // B has no screenshots and no capture bundle: nothing of A's may remain.
    await render(ITEM_B);

    expect(document.body.querySelectorAll('img[alt="screenshot"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Console & network');
  });
});
