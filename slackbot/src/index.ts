/**
 * Bifrost Slackbot Worker
 *
 * Handles Slack events for route management via natural language
 */

import { Hono } from 'hono';
import { EdgeRouterClient } from '@bifrost/shared';
import { verifySlackSignature, parseSlackPayload } from './slack/verify';
import type { SlackEventPayload } from './slack/verify';
import { getUserPermissions } from './auth/permissions';
import { handleEvent, postSlackMessage } from './slack/events';
import type { SlackbotBindings } from './auth/types';

type App = Hono<{ Bindings: SlackbotBindings }>;

const app: App = new Hono();

/**
 * Health check endpoint
 */
app.get('/health', c => {
  return c.json({
    status: 'ok',
    service: 'bifrost-slackbot',
    version: '0.9.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Slack Events API endpoint
 */
app.post('/slack/events', async c => {
  // Get raw body for signature verification
  const body = await c.req.text();

  // Get Slack headers
  const signature = c.req.header('X-Slack-Signature') || '';
  const timestamp = c.req.header('X-Slack-Request-Timestamp') || '';

  // Verify signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    body,
  );

  if (!isValid) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'Invalid Slack signature',
      }),
    );
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Parse payload
  const payload = parseSlackPayload(body);
  if (!payload) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  // Handle URL verification challenge
  if (payload.type === 'url_verification') {
    return c.json({ challenge: payload.challenge });
  }

  // Handle event callback
  if (payload.type === 'event_callback' && payload.event) {
    const event = payload.event;

    // Only handle app_mention and message.im
    if (event.type !== 'app_mention' && event.type !== 'message') {
      return c.json({ ok: true });
    }

    // Skip bot's own messages
    if (event.channel_type === 'im' && event.type === 'message') {
      // Check if this is a bot message (has subtype or bot_id)
      const rawPayload = JSON.parse(body) as SlackEventPayload & {
        event?: { subtype?: string; bot_id?: string };
      };
      if (rawPayload.event?.subtype || rawPayload.event?.bot_id) {
        return c.json({ ok: true });
      }
    }

    // Process event asynchronously
    c.executionCtx.waitUntil(
      processSlackEvent(payload, c.env).catch(error => {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Failed to process Slack event',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );

    // Return immediately (Slack requires 3s response)
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

/**
 * Process a Slack event asynchronously
 */
async function processSlackEvent(
  payload: SlackEventPayload,
  env: SlackbotBindings,
): Promise<void> {
  const event = payload.event;
  if (!event) return;

  // Get user permissions
  const permissions = await getUserPermissions(
    env.SLACK_PERMISSIONS,
    event.user,
  );

  // Create EdgeRouterClient
  const client = new EdgeRouterClient({
    baseUrl: env.EDGE_ROUTER_URL || 'https://henrychong.com',
    apiKey: env.ADMIN_API_KEY,
  });

  // Handle the event
  const response = await handleEvent(
    event,
    permissions,
    client,
    env.SLACK_BOT_TOKEN,
  );

  // Post response to Slack
  await postSlackMessage(
    env.SLACK_BOT_TOKEN,
    event.channel,
    response,
    event.thread_ts || event.ts,
  );

  console.info(
    JSON.stringify({
      level: 'info',
      message: 'Processed Slack event',
      eventType: event.type,
      user: event.user,
      channel: event.channel,
    }),
  );
}

export default app;
