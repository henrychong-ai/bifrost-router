/**
 * The new-feedback Slack notice (v1.47.0): dormant without its secret, never
 * throws, sends only server-set values, and logs a failure as a fixed
 * category without the URL or any error or answer text.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../src/types';
import {
  buildFeedbackSlackMessage,
  FEEDBACK_SLACK_TIMEOUT_MS,
  scheduleFeedbackSlackNotice,
  sendFeedbackSlackNotice,
} from '../../src/utils/feedback-slack-notice';
import { createSettlingExecutionContext } from '../helpers';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secretpart';
const ITEM = { shortId: 'F-7', type: 'bug' as const, priority: 1 };

const failed = (category: string) =>
  JSON.stringify({ level: 'warn', message: 'feedback-slack-notice-failed', category });

const mockFetch = vi.fn<typeof fetch>();

/** Schedule the notice from a handler, with or without an execution context. */
async function run(env: Partial<AppEnv['Bindings']>, withCtx: boolean): Promise<void> {
  const { ctx, settled } = createSettlingExecutionContext();
  const app = new Hono<AppEnv>().get('/', c => {
    scheduleFeedbackSlackNotice(c, ITEM);
    return c.text('done');
  });
  const res = withCtx
    ? await app.request('/', undefined, env, ctx)
    : await app.request('/', undefined, env);
  expect(res.status).toBe(200);
  await settled();
}

describe('feedback Slack notice', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  const loggedLines = (): string[] => warn.mock.calls.map(call => String(call[0]));

  it('builds a message from the short id, type and priority label only', () => {
    expect(buildFeedbackSlackMessage(ITEM)).toEqual({
      text: "New feedback F-7: bug, P1 - Urgent. Triage it on the dashboard's Feedback page.",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it.each([undefined, '', '   '])(
    'sends nothing and logs nothing when the secret is %j',
    async value => {
      await sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: value }, ITEM);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('posts JSON to the webhook, following no redirect, with a timeout signal', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: ` ${WEBHOOK} ` }, ITEM);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(buildFeedbackSlackMessage(ITEM));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    'http://hooks.slack.com/services/T000/B000/x',
    'https://example.com/services/T000/B000/x',
    'https://hooks.slack.com.example.net/services/x',
    'https://hooks.slack.com/other/T000/B000/x',
    'https://hooks.slack.com:8443/services/T000/B000/x',
    'not a url',
  ])('refuses a webhook value that is not a Slack incoming webhook (%s)', async value => {
    await sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: value }, ITEM);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(loggedLines()).toEqual([failed('config_invalid')]);
  });

  it('logs http_status on a non-2xx answer, never the URL or the answer', async () => {
    mockFetch.mockResolvedValue(new Response('invalid_token', { status: 403 }));
    await expect(
      sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: WEBHOOK }, ITEM),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([failed('http_status')]);
    expect(loggedLines().join('')).not.toContain('secretpart');
    expect(loggedLines().join('')).not.toContain('invalid_token');
  });

  it('a redirect answer is a failure, never followed', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    );
    await sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: WEBHOOK }, ITEM);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(loggedLines()).toEqual([failed('http_status')]);
  });

  it('logs network on a rejected fetch, never the error message', async () => {
    mockFetch.mockRejectedValue(new TypeError(`fetch failed for ${WEBHOOK}`));
    await expect(
      sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: WEBHOOK }, ITEM),
    ).resolves.toBeUndefined();
    expect(loggedLines()).toEqual([failed('network')]);
    expect(loggedLines().join('')).not.toContain('secretpart');
  });

  it('logs timeout when the request outlives its timeout', async () => {
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          // The runtime's own abort reason (a TimeoutError DOMException)
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('abort reason is not an Error'));
          });
        }),
    );
    const started = Date.now();
    await sendFeedbackSlackNotice({ FEEDBACK_SLACK_WEBHOOK_URL: WEBHOOK }, ITEM);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FEEDBACK_SLACK_TIMEOUT_MS - 100);
    expect(loggedLines()).toEqual([failed('timeout')]);
  }, 10_000);

  describe('scheduleFeedbackSlackNotice', () => {
    it('schedules the post through waitUntil when the secret is set', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await run({ FEEDBACK_SLACK_WEBHOOK_URL: WEBHOOK }, true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('schedules nothing without the secret', async () => {
      await run({}, true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([42, {}, ['x'], true])(
      'schedules nothing, and never throws, for a binding that is not a string (%j)',
      async value => {
        await run({ FEEDBACK_SLACK_WEBHOOK_URL: value as unknown as string }, true);
        await sendFeedbackSlackNotice(
          { FEEDBACK_SLACK_WEBHOOK_URL: value as unknown as string },
          ITEM,
        );
        expect(mockFetch).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('skips quietly when there is no execution context', async () => {
      await run({ FEEDBACK_SLACK_WEBHOOK_URL: WEBHOOK }, false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
