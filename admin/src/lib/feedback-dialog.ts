/**
 * Feedback dialog opener (v1.26.0; typed source + re-entrancy guard).
 *
 * A tiny window-event bus so any trigger — the header button, the in-dialog
 * button, or the global keyboard shortcut — can open the single feedback dialog
 * mounted in AppLayout. The screenshot is captured HERE, before the dialog
 * renders, so the dialog overlay isn't in the shot (and so a source popup, still
 * open at capture time, IS in the shot).
 */

import { captureScreenshot } from './screenshot';
import { addBreadcrumb } from './capture';

export const FEEDBACK_OPEN_EVENT = 'bifrost:open-feedback';

/** Where a feedback-open was triggered from (recorded as a breadcrumb for triage). */
export type FeedbackTriggerSource =
  | 'header'
  | 'command-palette'
  | 'feedback-page'
  | 'dialog'
  | 'shortcut';

export interface FeedbackOpenDetail {
  screenshot: Blob | null;
}

let dialogOpen = false;

/** Whether the feedback dialog is currently open (re-entrancy guard state). */
export function isFeedbackDialogOpen(): boolean {
  return dialogOpen;
}

/** Sync the guard with the dialog's real open state (called by FeedbackDialog). */
export function setFeedbackDialogOpen(open: boolean): void {
  dialogOpen = open;
}

/**
 * Capture the current page (best-effort), then open the feedback dialog. No-ops
 * if the dialog is already open — re-entrancy guard for e.g. the global shortcut
 * pressed while the feedback form has focus.
 */
export async function openFeedbackDialog(source: FeedbackTriggerSource): Promise<void> {
  if (dialogOpen) return;
  // Claim immediately so the async capture window can't double-open (a second
  // trigger fired before the dialog mounts would otherwise re-dispatch and reset
  // the form). FeedbackDialog clears this when it actually closes / unmounts.
  dialogOpen = true;
  addBreadcrumb('feedback-open', source);
  let screenshot: Blob | null = null;
  try {
    screenshot = await captureScreenshot();
  } catch {
    screenshot = null;
  }
  window.dispatchEvent(
    new CustomEvent<FeedbackOpenDetail>(FEEDBACK_OPEN_EVENT, { detail: { screenshot } }),
  );
}
