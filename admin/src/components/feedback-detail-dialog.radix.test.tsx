// @vitest-environment happy-dom

/**
 * The triage dialog's Priority trigger, rendered through the REAL Radix Select.
 *
 * `feedback-dialog.test.tsx` mocks `@/components/ui/select` for its option
 * assertions. A mock that rendered `SelectValue`'s placeholder unconditionally
 * would NOT be what Radix does, and would green-light a fix that is inert in
 * the browser: Radix `shouldShowPlaceholder` is `value === '' || value ===
 * undefined`, and the bound value here is neither, so a placeholder never shows
 * and an off-scale value would draw an EMPTY trigger. This file therefore mocks
 * no Select at all - the closed trigger is rendered by the real component, so
 * the assertion is about Radix's actual behaviour.
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
  api: { feedback: { attachment: vi.fn(async () => new Blob(['{}'])) } },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FeedbackDetailDialog } from './feedback-detail-dialog';

function itemFixture(priority: number): FeedbackItem {
  return {
    id: '0190abcd-0000-7000-8000-000000000000',
    shortId: 'F-1',
    type: 'bug',
    priority,
    status: 'new',
    title: 'Request failed with status code 403',
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
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** The closed trigger for the Priority control (the one following its Label). */
function priorityTriggerText(): string {
  const trigger = [...document.body.querySelectorAll('button[role="combobox"]')].find(
    button => button.previousElementSibling?.textContent === 'Priority',
  );
  return trigger?.textContent ?? '';
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

async function renderDialog(priority: number) {
  mocks.item = itemFixture(priority);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<FeedbackDetailDialog id="F-1" open onOpenChange={() => undefined} />);
  });
}

describe('triage dialog priority trigger (real Radix Select)', () => {
  it('shows the label for an in-scale level', async () => {
    await renderDialog(2);
    expect(priorityTriggerText()).toContain('P2 - Important');
  });

  it('shows the default label for the bottom of the scale', async () => {
    await renderDialog(3);
    expect(priorityTriggerText()).toContain('P3 - Routine');
  });

  it('shows the top of the scale rather than the bottom default', async () => {
    await renderDialog(0);
    const text = priorityTriggerText();
    expect(text).toContain('P0 - Mission-critical');
    expect(text).not.toContain('P3 - Routine');
  });

  // The fail-closed rule: no SelectItem matches 4, so a `placeholder` prop
  // alone would render an EMPTY trigger while the queue table showed "P4".
  it('shows P4 for an off-scale value instead of an empty trigger', async () => {
    await renderDialog(4);
    const text = priorityTriggerText();
    expect(text).toContain('P4');
    expect(text.trim()).not.toBe('');
  });
});
