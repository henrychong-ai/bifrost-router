/**
 * Slack notice for a new feedback submission (v1.47.0). Optional and dormant:
 * it acts only when the Worker secret `FEEDBACK_SLACK_WEBHOOK_URL` is set.
 * Unset (or empty), a submission schedules nothing, sends nothing and logs
 * nothing; setting the secret is the per-environment switch, deleting it
 * turns the notice off again.
 *
 * The notice never delays or fails a submission: it is scheduled with
 * `waitUntil` after the 201 is built, the request has a short timeout, and
 * every failure is swallowed and logged as one line with a fixed category,
 * never the URL or an error's text.
 *
 * Feedback text is untrusted, so the message carries only values the server
 * sets: the short id, the type and the priority label. Never the title,
 * description, steps, capture, submitter or anything else a submitter wrote
 * or that identifies a person. The Worker does not know where the dashboard
 * is served, so the message carries no link.
 */

import { type FeedbackItem, formatFeedbackPriority } from '@bifrost/shared';
import type { Context } from 'hono';
import type { AppEnv, Bindings } from '../types';
import { slackIncomingWebhook } from './slack-webhook';

/** Upper bound on the Slack request; the answer has already gone out. */
export const FEEDBACK_SLACK_TIMEOUT_MS = 3000;

/** The fixed category of a failed notice, the only detail its log line carries. */
export type FeedbackSlackFailure = 'config_invalid' | 'timeout' | 'network' | 'http_status';

type NoticeItem = Pick<FeedbackItem, 'shortId' | 'type' | 'priority'>;

/**
 * The configured webhook text, trimmed, or `null` when none is set: unset,
 * empty, or not a string at all (a binding of another type), which is no
 * configuration either.
 */
function configuredWebhook(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The one log line for a failed notice: a fixed message and category. */
function logFailure(category: FeedbackSlackFailure): void {
  console.warn(
    JSON.stringify({ level: 'warn', message: 'feedback-slack-notice-failed', category }),
  );
}

/** The Slack message body: server-set values only (see the file header). */
export function buildFeedbackSlackMessage(item: NoticeItem): {
  text: string;
  unfurl_links: false;
  unfurl_media: false;
} {
  return {
    text: `New feedback ${item.shortId}: ${item.type}, ${formatFeedbackPriority(item.priority)}. Triage it on the dashboard's Feedback page.`,
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * Post the notice. Never throws or rejects: a failure becomes one log line.
 * Does nothing when the secret is unset or empty.
 */
export async function sendFeedbackSlackNotice(
  env: Pick<Bindings, 'FEEDBACK_SLACK_WEBHOOK_URL'>,
  item: NoticeItem,
): Promise<void> {
  const raw = configuredWebhook(env.FEEDBACK_SLACK_WEBHOOK_URL);
  if (raw === null) return;
  const url = slackIncomingWebhook(raw);
  if (!url) {
    logFailure('config_invalid');
    return;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildFeedbackSlackMessage(item)),
      signal: AbortSignal.timeout(FEEDBACK_SLACK_TIMEOUT_MS),
    });
    // Release the connection; the answer's content is never read
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) logFailure('http_status');
  } catch (error) {
    // The error can carry the URL: only its kind is logged
    logFailure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  }
}

/**
 * Schedule the notice after the answer. An unset secret schedules nothing; a
 * missing execution context (unit tests) skips it, as the audit write does.
 */
export function scheduleFeedbackSlackNotice(c: Context<AppEnv>, item: NoticeItem): void {
  // Never throws, whatever the binding holds: the caller has already
  // committed the item, and a throw here would fail its answer
  try {
    if (configuredWebhook(c.env.FEEDBACK_SLACK_WEBHOOK_URL) === null) return;
    c.executionCtx.waitUntil(sendFeedbackSlackNotice(c.env, item));
  } catch {
    // executionCtx not available (tests), or an unreadable binding: no notice
  }
}
