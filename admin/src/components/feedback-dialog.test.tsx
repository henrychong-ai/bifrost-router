// @vitest-environment happy-dom

/**
 * Acceptance coverage for the Priority control on the feedback CREATION form.
 *
 * The requirement is about wording on both halves of the control: the four full
 * labels in the list, and the chosen label on the trigger. The
 * `@/components/ui/select` mock therefore renders the trigger and its value (a
 * native `<select>` shows the selected `<option>`'s text), which is what lets
 * the trigger assertion mean anything.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async (_form: FormData) => ({ shortId: 'F-9' })),
}));

vi.mock('@/hooks/use-feedback', () => ({
  useSubmitFeedback: () => ({ mutateAsync: mocks.submit, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real capture reads live console/network buffers and the page URL.
vi.mock('@/lib/capture', () => ({
  buildFeedbackContext: () => ({ url: 'http://localhost/', timestamp: '2026-09-10T00:00:00Z' }),
  getCaptureBundle: () => ({ console: [], network: [], breadcrumbs: [] }),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={event => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Faithful to Radix for how this app uses it: CHILDREN win whenever they are
  // supplied, and the placeholder shows only when they are not. A
  // placeholder-always mock would hide the very bug the children fallback
  // exists to fix — see feedback-detail-dialog.radix.test.tsx.
  SelectValue: ({ placeholder, children }: { placeholder?: ReactNode; children?: ReactNode }) => (
    <>{children ?? placeholder}</>
  ),
}));

import { FEEDBACK_OPEN_EVENT } from '@/lib/feedback-dialog';
import { FeedbackDialog } from './feedback-dialog';

const PRIORITY_LABELS = ['P0 - Mission-critical', 'P1 - Urgent', 'P2 - Important', 'P3 - Routine'];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function openDialog() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <FeedbackDialog />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN_EVENT, { detail: { screenshot: null } }));
  });
}

/** The one Select whose options are the P0-P3 labels. */
function prioritySelect(): HTMLSelectElement | undefined {
  return [...document.body.querySelectorAll('select')].find(select =>
    [...select.options].some(option => option.textContent === PRIORITY_LABELS[0]),
  );
}

type Fillable = HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement;

/**
 * Set a value through the NATIVE setter so React's own value tracker sees the
 * change (assigning `.value` directly is swallowed on a controlled input), then
 * fire the event React listens for. The prototype has to match the element:
 * happy-dom's textarea holds private fields an input's setter cannot write.
 */
function setValue(element: Fillable, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
}

function sendButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(
    button => button.textContent === 'Send feedback',
  );
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.submit.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('feedback creation dialog - priority', () => {
  it('lists the four levels by their full label', async () => {
    await openDialog();
    const priority = prioritySelect();
    expect(priority).toBeTruthy();
    expect([...(priority?.options ?? [])].map(option => option.textContent)).toEqual(
      PRIORITY_LABELS,
    );
    expect([...(priority?.options ?? [])].map(option => option.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
  });

  it('pre-selects P3 - Routine and shows that label on the trigger', async () => {
    await openDialog();
    const priority = prioritySelect();
    expect(priority?.value).toBe('3');
    expect(priority?.selectedOptions[0]?.textContent).toBe('P3 - Routine');
  });

  it('shows the chosen label on the trigger after selecting another level', async () => {
    await openDialog();
    const priority = prioritySelect() as HTMLSelectElement;
    await act(async () => setValue(priority, '0'));
    expect(priority.value).toBe('0');
    expect(priority.selectedOptions[0]?.textContent).toBe('P0 - Mission-critical');
  });

  it('submits the chosen priority in the multipart body', async () => {
    await openDialog();
    const title = document.querySelector<HTMLInputElement>('#feedback-title');
    const description = document.querySelector<HTMLTextAreaElement>('#feedback-description');
    await act(async () => setValue(title as HTMLInputElement, 'It broke'));
    await act(async () => setValue(description as HTMLTextAreaElement, 'Clicking does nothing'));
    await act(async () => setValue(prioritySelect() as HTMLSelectElement, '1'));

    await act(async () => sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(mocks.submit).toHaveBeenCalledTimes(1);
    const form = mocks.submit.mock.calls[0]?.[0];
    expect(form?.get('priority')).toBe('1');
    expect(form?.get('title')).toBe('It broke');
    // Priority is the only urgency axis - the form carries no severity.
    expect(form?.get('severity')).toBeNull();
  });

  it('always sends a priority, defaulting to P3, even when untouched', async () => {
    await openDialog();
    await act(async () =>
      setValue(
        document.querySelector<HTMLInputElement>('#feedback-title') as HTMLInputElement,
        't',
      ),
    );
    await act(async () =>
      setValue(
        document.querySelector<HTMLTextAreaElement>('#feedback-description') as HTMLTextAreaElement,
        'd',
      ),
    );
    await act(async () => sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(mocks.submit.mock.calls[0]?.[0]?.get('priority')).toBe('3');
  });

  it('resets the priority back to P3 - Routine when the dialog is reopened', async () => {
    await openDialog();
    await act(async () => setValue(prioritySelect() as HTMLSelectElement, '0'));
    expect(prioritySelect()?.value).toBe('0');

    const cancel = [...document.body.querySelectorAll('button')].find(
      button => button.textContent === 'Cancel',
    );
    await act(async () => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN_EVENT, { detail: { screenshot: null } }));
    });

    expect(prioritySelect()?.value).toBe('3');
    expect(prioritySelect()?.selectedOptions[0]?.textContent).toBe('P3 - Routine');
  });
});
