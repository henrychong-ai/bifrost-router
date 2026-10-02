import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBreadcrumb } from './capture';
import {
  FEEDBACK_OPEN_EVENT,
  isFeedbackDialogOpen,
  openFeedbackDialog,
  setFeedbackDialogOpen,
} from './feedback-dialog';
import { captureScreenshot } from './screenshot';

vi.mock('./screenshot', () => ({
  captureScreenshot: vi.fn<() => Promise<Blob | null>>().mockResolvedValue(null),
}));
vi.mock('./capture', () => ({ addBreadcrumb: vi.fn<(...args: unknown[]) => void>() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { dispatchEvent: vi.fn<(event: Event) => boolean>() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setFeedbackDialogOpen(false);
});

// =============================================================================
// openFeedbackDialog
// =============================================================================

describe('openFeedbackDialog', () => {
  it('records a breadcrumb and dispatches the open event once', async () => {
    await openFeedbackDialog('header');

    expect(addBreadcrumb).toHaveBeenCalledWith('feedback-open', 'header');
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);

    const firstDispatch = vi.mocked(window.dispatchEvent).mock.calls[0];
    assert(firstDispatch !== undefined, 'expected a dispatched event');
    const event = firstDispatch[0] as CustomEvent;
    expect(event).toBeInstanceOf(CustomEvent);
    expect(event.type).toBe(FEEDBACK_OPEN_EVENT);
  });

  it('no-ops while the dialog is already open (re-entrancy guard)', async () => {
    setFeedbackDialogOpen(true);

    await openFeedbackDialog('shortcut');

    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});

// =============================================================================
// isFeedbackDialogOpen / setFeedbackDialogOpen
// =============================================================================

describe('isFeedbackDialogOpen', () => {
  it('reflects the guard state set by setFeedbackDialogOpen', () => {
    expect(isFeedbackDialogOpen()).toBe(false);

    setFeedbackDialogOpen(true);
    expect(isFeedbackDialogOpen()).toBe(true);

    setFeedbackDialogOpen(false);
    expect(isFeedbackDialogOpen()).toBe(false);
  });
});
