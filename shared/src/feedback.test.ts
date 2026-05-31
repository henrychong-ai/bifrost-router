import { describe, it, expect } from 'vitest';
import {
  CreateFeedbackSchema,
  FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES,
  FEEDBACK_DESCRIPTION_MAX_LENGTH,
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_RATE_LIMIT_PER_MINUTE,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_TITLE_MAX_LENGTH,
  FEEDBACK_TYPES,
  TriageFeedbackSchema,
  formatFeedbackShortId,
  redactCaptureBundle,
  redactSensitive,
  sanitizeFeedbackText,
  uuidv7,
} from './feedback.js';

describe('feedback enums + caps', () => {
  it('type enum is bug/feature/question/other (no "issue")', () => {
    expect(FEEDBACK_TYPES).toEqual(['bug', 'feature', 'question', 'other']);
    expect(FEEDBACK_TYPES).not.toContain('issue');
  });

  it('severity tops out at critical (disjoint from priority "urgent")', () => {
    expect(FEEDBACK_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
    expect(FEEDBACK_SEVERITIES).not.toContain('urgent');
  });

  it('status lifecycle', () => {
    expect(FEEDBACK_STATUSES).toContain('new');
    expect(FEEDBACK_STATUSES).toContain('resolved');
    expect(FEEDBACK_STATUSES).toContain('duplicate');
  });

  it('caps have the decided values', () => {
    expect(FEEDBACK_TITLE_MAX_LENGTH).toBe(200);
    expect(FEEDBACK_DESCRIPTION_MAX_LENGTH).toBe(5000);
    expect(FEEDBACK_MAX_SCREENSHOTS).toBe(3);
    expect(FEEDBACK_SCREENSHOT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES).toBe(256 * 1024);
    expect(FEEDBACK_RATE_LIMIT_PER_MINUTE).toBe(10);
  });
});

describe('sanitizeFeedbackText', () => {
  it('trims and returns null for empty', () => {
    expect(sanitizeFeedbackText('   ', 100)).toBeNull();
    expect(sanitizeFeedbackText(null, 100)).toBeNull();
    expect(sanitizeFeedbackText(undefined, 100)).toBeNull();
  });

  it('strips control chars but keeps tab/newline', () => {
    expect(sanitizeFeedbackText('a bc', 100)).toBe('abc');
    expect(sanitizeFeedbackText('line1\nline2\tend', 100)).toBe('line1\nline2\tend');
  });

  it('clamps to maxLength', () => {
    expect(sanitizeFeedbackText('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('uuidv7', () => {
  it('produces a valid v7 UUID (version nibble 7, RFC variant)', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });
});

describe('formatFeedbackShortId', () => {
  it('formats F-<n> with no padding', () => {
    expect(formatFeedbackShortId(1)).toBe('F-1');
    expect(formatFeedbackShortId(142)).toBe('F-142');
  });
});

describe('redactSensitive', () => {
  it('strips JWT-pattern strings', () => {
    // Assembled from parts so the source has no contiguous JWT (gitleaks),
    // but the runtime value still matches the redaction pattern.
    const jwt = ['eyJhbGciOi', 'eyJzdWIiOiJ4', 'SflKxwRJSMeKKF2QT4'].join('.');
    expect(redactSensitive(`token=${jwt}`)).toContain('[REDACTED]');
    expect(redactSensitive(`token=${jwt}`)).not.toContain('eyJhbGciOi');
  });

  it('strips Bearer tokens', () => {
    expect(redactSensitive('Authorization: Bearer abc.def-ghi')).toContain('[REDACTED]');
  });

  it('strips session values', () => {
    expect(redactSensitive('session_jwt=abc123def')).toContain('[REDACTED]');
  });

  it('strips token-bearing URL query params (value only, keeps key)', () => {
    const out = redactSensitive('https://x/cb?access_token=secret12345&ok=1');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('secret12345');
    expect(out).toContain('access_token=');
    expect(out).toContain('ok=1');
  });

  it('strips URL userinfo credentials', () => {
    const out = redactSensitive('connect https://user:p4ss@host/path failed');
    expect(out).not.toContain('p4ss');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves clean text untouched', () => {
    expect(redactSensitive('a normal log line')).toBe('a normal log line');
  });
});

describe('redactCaptureBundle', () => {
  it('redacts console messages, network urls, and breadcrumbs', () => {
    const out = redactCaptureBundle({
      console: [{ level: 'error', message: 'failed Bearer abc.def.ghi', ts: 1 }],
      network: [{ method: 'GET', url: 'https://x/?session_jwt=zzz', status: 500, ts: 1 }],
      breadcrumbs: [
        {
          type: 'nav',
          detail: `token ${['eyJhbGci', 'eyJzdWIi', 'SflKxwRJ'].join('.')} here`,
          ts: 1,
        },
      ],
    });
    expect(out.console[0].message).toContain('[REDACTED]');
    expect(out.network[0].url).toContain('[REDACTED]');
    expect(out.breadcrumbs[0].detail).toContain('[REDACTED]');
  });
});

describe('Zod schemas', () => {
  it('CreateFeedbackSchema accepts a valid submission', () => {
    const r = CreateFeedbackSchema.safeParse({
      type: 'bug',
      title: 'It broke',
      description: 'Here is what happened',
      severity: 'high',
    });
    expect(r.success).toBe(true);
  });

  it('CreateFeedbackSchema accepts optional submitter metadata', () => {
    const r = CreateFeedbackSchema.safeParse({
      type: 'bug',
      title: 'It broke',
      description: 'Details',
      submitterEmail: 'someone@example.com',
      submitterName: 'Someone',
    });
    expect(r.success).toBe(true);
  });

  it('CreateFeedbackSchema rejects an invalid type and over-length title', () => {
    expect(
      CreateFeedbackSchema.safeParse({ type: 'issue', title: 'x', description: 'y' }).success,
    ).toBe(false);
    expect(
      CreateFeedbackSchema.safeParse({
        type: 'bug',
        title: 'x'.repeat(FEEDBACK_TITLE_MAX_LENGTH + 1),
        description: 'y',
      }).success,
    ).toBe(false);
  });

  it('TriageFeedbackSchema accepts partial patches and clamps priority', () => {
    expect(TriageFeedbackSchema.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(TriageFeedbackSchema.safeParse({ priority: 5 }).success).toBe(false);
    expect(TriageFeedbackSchema.safeParse({ priority: 2 }).success).toBe(true);
  });
});
