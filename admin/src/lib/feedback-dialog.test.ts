import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openFeedbackDialog,
  setFeedbackDialogOpen,
  isFeedbackDialogOpen,
  FEEDBACK_OPEN_EVENT,
} from './feedback-dialog';
import { captureScreenshot } from './screenshot';
import { addBreadcrumb } from './capture';

vi.mock('./screenshot', () => ({ captureScreenshot: vi.fn().mockResolvedValue(null) }));
vi.mock('./capture', () => ({ addBreadcrumb: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
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

    const event = vi.mocked(window.dispatchEvent).mock.calls[0][0] as CustomEvent;
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
