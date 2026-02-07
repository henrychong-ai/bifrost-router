/**
 * Tests for Slack signature verification
 */

import { describe, it, expect } from 'vitest';
import { verifySlackSignature, parseSlackPayload } from '../src/slack/verify';

describe('verifySlackSignature', () => {
  const signingSecret = 'test-signing-secret-12345';

  /**
   * Generate a valid Slack signature for testing
   */
  async function generateSignature(
    secret: string,
    timestamp: string,
    body: string
  ): Promise<string> {
    const sigBasestring = `v0:${timestamp}:${body}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(sigBasestring);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const signatureArray = Array.from(new Uint8Array(signatureBuffer));
    return 'v0=' + signatureArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  describe('valid signatures', () => {
    it('should accept a valid signature', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = '{"type":"url_verification","challenge":"test"}';
      const signature = await generateSignature(signingSecret, timestamp, body);

      const result = await verifySlackSignature(signingSecret, signature, timestamp, body);

      expect(result).toBe(true);
    });

    it('should accept signature with JSON event payload', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'app_mention',
          user: 'U123456',
          text: '<@BOTID> list routes',
          channel: 'C123456',
          ts: '1234567890.123456',
        },
      });
      const signature = await generateSignature(signingSecret, timestamp, body);

      const result = await verifySlackSignature(signingSecret, signature, timestamp, body);

      expect(result).toBe(true);
    });
  });

  describe('invalid signatures', () => {
    it('should reject an invalid signature', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = '{"type":"url_verification","challenge":"test"}';
      const invalidSignature = 'v0=invalid123456789';

      const result = await verifySlackSignature(
        signingSecret,
        invalidSignature,
        timestamp,
        body
      );

      expect(result).toBe(false);
    });

    it('should reject signature with wrong secret', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = '{"type":"url_verification","challenge":"test"}';
      const signature = await generateSignature('wrong-secret', timestamp, body);

      const result = await verifySlackSignature(signingSecret, signature, timestamp, body);

      expect(result).toBe(false);
    });

    it('should reject signature with tampered body', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const originalBody = '{"type":"url_verification","challenge":"test"}';
      const signature = await generateSignature(signingSecret, timestamp, originalBody);
      const tamperedBody = '{"type":"url_verification","challenge":"hacked"}';

      const result = await verifySlackSignature(
        signingSecret,
        signature,
        timestamp,
        tamperedBody
      );

      expect(result).toBe(false);
    });
  });

  describe('replay attack protection', () => {
    it('should reject timestamp older than 5 minutes', async () => {
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 301).toString(); // 5+ minutes ago
      const body = '{"type":"url_verification","challenge":"test"}';
      const signature = await generateSignature(signingSecret, oldTimestamp, body);

      const result = await verifySlackSignature(
        signingSecret,
        signature,
        oldTimestamp,
        body
      );

      expect(result).toBe(false);
    });

    it('should reject timestamp from the future (>5 minutes)', async () => {
      const futureTimestamp = (Math.floor(Date.now() / 1000) + 301).toString(); // 5+ minutes in future
      const body = '{"type":"url_verification","challenge":"test"}';
      const signature = await generateSignature(signingSecret, futureTimestamp, body);

      const result = await verifySlackSignature(
        signingSecret,
        signature,
        futureTimestamp,
        body
      );

      expect(result).toBe(false);
    });

    it('should accept timestamp within 5 minute window', async () => {
      const recentTimestamp = (Math.floor(Date.now() / 1000) - 60).toString(); // 1 minute ago
      const body = '{"type":"url_verification","challenge":"test"}';
      const signature = await generateSignature(signingSecret, recentTimestamp, body);

      const result = await verifySlackSignature(
        signingSecret,
        signature,
        recentTimestamp,
        body
      );

      expect(result).toBe(true);
    });

    it('should reject invalid timestamp format', async () => {
      const invalidTimestamp = 'not-a-number';
      const body = '{"type":"url_verification","challenge":"test"}';
      const signature = 'v0=doesntmatter';

      const result = await verifySlackSignature(
        signingSecret,
        signature,
        invalidTimestamp,
        body
      );

      expect(result).toBe(false);
    });
  });
});

describe('parseSlackPayload', () => {
  describe('valid payloads', () => {
    it('should parse URL verification payload', () => {
      const body = JSON.stringify({
        type: 'url_verification',
        challenge: 'test-challenge-123',
      });

      const result = parseSlackPayload(body);

      expect(result).toEqual({
        type: 'url_verification',
        challenge: 'test-challenge-123',
      });
    });

    it('should parse event_callback with app_mention', () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        api_app_id: 'A123',
        event: {
          type: 'app_mention',
          user: 'U123456',
          text: '<@BOTID> help',
          channel: 'C123456',
          ts: '1234567890.123456',
        },
        event_id: 'Ev123',
        event_time: 1234567890,
      });

      const result = parseSlackPayload(body);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('event_callback');
      expect(result?.event?.type).toBe('app_mention');
      expect(result?.event?.user).toBe('U123456');
      expect(result?.event?.text).toBe('<@BOTID> help');
    });

    it('should parse event_callback with direct message', () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U123456',
          text: 'list routes',
          channel: 'D123456',
          ts: '1234567890.123456',
          channel_type: 'im',
        },
      });

      const result = parseSlackPayload(body);

      expect(result).not.toBeNull();
      expect(result?.event?.type).toBe('message');
      expect(result?.event?.channel_type).toBe('im');
    });

    it('should parse payload with thread_ts for threaded replies', () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'app_mention',
          user: 'U123456',
          text: '<@BOTID> help',
          channel: 'C123456',
          ts: '1234567890.654321',
          thread_ts: '1234567890.123456',
        },
      });

      const result = parseSlackPayload(body);

      expect(result).not.toBeNull();
      expect(result?.event?.thread_ts).toBe('1234567890.123456');
    });
  });

  describe('invalid payloads', () => {
    it('should return null for invalid JSON', () => {
      const body = 'not valid json {';

      const result = parseSlackPayload(body);

      expect(result).toBeNull();
    });

    it('should return null for payload without type', () => {
      const body = JSON.stringify({
        event: {
          type: 'app_mention',
        },
      });

      const result = parseSlackPayload(body);

      expect(result).toBeNull();
    });

    it('should return null for empty string', () => {
      const result = parseSlackPayload('');

      expect(result).toBeNull();
    });
  });
});
