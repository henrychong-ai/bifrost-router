/**
 * Slack request signature verification
 *
 * Implements Slack's signature verification using HMAC-SHA256
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

/**
 * Verify a Slack request signature
 *
 * @param signingSecret - Slack app signing secret
 * @param signature - X-Slack-Signature header value
 * @param timestamp - X-Slack-Request-Timestamp header value
 * @param body - Raw request body string
 * @returns true if signature is valid
 */
export async function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  // Reject if timestamp is more than 5 minutes old (replay attack protection)
  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);

  if (isNaN(requestTime)) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'Invalid Slack timestamp',
        timestamp,
      }),
    );
    return false;
  }

  if (Math.abs(currentTime - requestTime) > 300) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'Slack request timestamp too old',
        currentTime,
        requestTime,
        diff: Math.abs(currentTime - requestTime),
      }),
    );
    return false;
  }

  // Build the signature base string
  const sigBasestring = `v0:${timestamp}:${body}`;

  // Compute HMAC-SHA256
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingSecret);
  const messageData = encoder.encode(sigBasestring);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const computedSignature =
    'v0=' + signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // Timing-safe comparison
  return timingSafeEqual(computedSignature, signature);
}

/**
 * Timing-safe string comparison to prevent timing attacks
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }

  return result === 0;
}

/**
 * Slack event payload structure
 */
export interface SlackEventPayload {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
  type: string;
  challenge?: string;
  event_id?: string;
  event_time?: number;
}

/**
 * Slack event structure
 */
export interface SlackEvent {
  type: string;
  user: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
}

/**
 * Parse and validate a Slack event payload
 *
 * @param body - Raw request body string
 * @returns Parsed payload or null if invalid
 */
export function parseSlackPayload(body: string): SlackEventPayload | null {
  try {
    const payload = JSON.parse(body) as SlackEventPayload;

    // Must have a type
    if (!payload.type) {
      return null;
    }

    return payload;
  } catch {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to parse Slack payload',
      }),
    );
    return null;
  }
}
