/**
 * Feedback contract (v1.26.0) — the single source of truth for the AI-actionable
 * feedback work-queue shared by the Worker backend, the MCP server, and the
 * admin dashboard.
 *
 * Holds: the enums (type / severity / status), the fixed caps, the Zod schemas
 * for submit + triage, the text sanitiser, a dependency-free RFC-9562 UUIDv7
 * generator, the `F-<n>` short-id formatter, and the credential-redaction helper
 * applied to console / network captures before they are stored.
 *
 * Auth model: the Bifrost admin API is gated by a single ADMIN_API_KEY (no
 * multi-user auth). There is one admin who sees ALL feedback, so there is no
 * submitter-scoping and no actor roles. `submitter_*` are OPTIONAL free-text
 * metadata the submitter may type into the dialog — they are NOT identity claims
 * from auth.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Caps (fixed limits)
// ---------------------------------------------------------------------------

/** Max length of the feedback title. */
export const FEEDBACK_TITLE_MAX_LENGTH = 200;
/** Max length of the feedback description. */
export const FEEDBACK_DESCRIPTION_MAX_LENGTH = 5000;
/** Max length of each optional structured field (steps / expected / actual). */
export const FEEDBACK_FIELD_MAX_LENGTH = 2000;
/** Max length of a single triage-note / labels / area string. */
export const FEEDBACK_TRIAGE_FIELD_MAX_LENGTH = 2000;
/** Max length of an optional submitter email / name. */
export const FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH = 320;
/** Max number of screenshots accepted per submission. */
export const FEEDBACK_MAX_SCREENSHOTS = 3;
/** Max size of a single screenshot (5 MB). */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
/** Max size of the console/network/breadcrumb capture bundle JSON (256 KB). */
export const FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES = 256 * 1024;
/** Per-user submission rate limit (submissions per minute). Handled by Cloudflare WAF. */
export const FEEDBACK_RATE_LIMIT_PER_MINUTE = 10;

// ---------------------------------------------------------------------------
// Enums (research-backed taxonomy)
// ---------------------------------------------------------------------------

/** Submission category. "issue" intentionally dropped (synonym of bug); "other" is the catch-all. */
export const FEEDBACK_TYPES = ['bug', 'feature', 'question', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Submitter-set technical impact. Tops out at "critical" (priority owns "urgent"). */
export const FEEDBACK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

/** Triage lifecycle. */
export const FEEDBACK_STATUSES = [
  'new',
  'triaged',
  'in_progress',
  'resolved',
  'wontfix',
  'duplicate',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Triage-set priority (Linear): 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const FEEDBACK_PRIORITY_MIN = 0;
export const FEEDBACK_PRIORITY_MAX = 4;

/** Suggested (free-form, not enforced) `area` vocabulary, bifrost-component-oriented. */
export const FEEDBACK_AREAS = [
  'routes',
  'storage',
  'analytics',
  'audit',
  'mcp',
  'ui',
  'perf',
  'security',
  'docs',
] as const;

// ---------------------------------------------------------------------------
// Text sanitiser
// ---------------------------------------------------------------------------

function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10) {
      out += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Sanitise a free-text feedback field: normalise newlines, strip control chars,
 * trim, return null when empty, clamp to `maxLength`.
 */
export function sanitizeFeedbackText(
  raw: string | null | undefined,
  maxLength: number,
): string | null {
  if (raw == null) return null;
  const normalised = raw.replace(/\r\n?/g, '\n');
  const trimmed = stripControlChars(normalised).trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Generate an RFC-9562 UUIDv7 (48-bit Unix-ms timestamp + 74 random bits).
 * Time-ordered and index-friendly. Dependency-free: uses Web Crypto, available
 * in Cloudflare Workers, browsers, and Node 19+. `crypto.randomUUID()` is v4
 * only, so we assemble the bytes by hand.
 */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  // 48-bit big-endian millisecond timestamp in bytes 0..5.
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  // 74 random bits in bytes 6..15.
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  bytes.set(rand, 6);
  // version (0b0111) in the high nibble of byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant (0b10) in the high bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Prefix for the human-quotable short id. */
export const FEEDBACK_SHORT_ID_PREFIX = 'F';

/** Format a sequential counter value into the `F-<n>` short id (no zero-padding). */
export function formatFeedbackShortId(n: number): string {
  return `${FEEDBACK_SHORT_ID_PREFIX}-${n}`;
}

// ---------------------------------------------------------------------------
// Credential redaction (applied to console + network captures before storage)
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS: readonly RegExp[] = [
  // JWT-shaped strings — three base64url segments.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // session / session_jwt key=value or "key": "value".
  /session(?:_jwt)?["'\s]*[:=]["'\s]*[A-Za-z0-9._-]+/gi,
  // Authorization / Cookie / Set-Cookie header lines.
  /\b(?:authorization|cookie|set-cookie)["'\s]*[:=][^\n\r]*/gi,
  // Token-bearing URL query params — redact just the value, keep the key
  // (e.g. ?access_token=… in a captured network URL). Variable-length lookbehind.
  /(?<=[?&](?:access_token|refresh_token|session_token|id_token|api[_-]?key|apikey|token|secret|password|pwd)=)[^&#\s]+/gi,
  // URL userinfo (https://user:pass@host) — redact the credentials.
  /(?<=\/\/)[^/@\s:]+:[^/@\s]+(?=@)/g,
];

/** The literal substituted in place of any redacted credential. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Strip auth headers, cookies, Bearer tokens, and JWT-pattern strings from a string. */
export function redactSensitive(input: string): string {
  let out = input;
  for (const re of REDACTION_PATTERNS) {
    out = out.replace(re, REDACTION_PLACEHOLDER);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capture-bundle + context shapes
// ---------------------------------------------------------------------------

export interface FeedbackConsoleEntry {
  level: 'error' | 'warn' | 'log';
  message: string;
  ts: number;
}

export interface FeedbackNetworkEntry {
  /** HTTP method. */
  method: string;
  /** Request URL (no body — status + URL + method only). */
  url: string;
  /** Response status (0 if the request threw before a response). */
  status: number;
  ts: number;
}

export interface FeedbackBreadcrumb {
  type: string;
  detail: string;
  ts: number;
}

export interface FeedbackCaptureBundle {
  console: FeedbackConsoleEntry[];
  network: FeedbackNetworkEntry[];
  breadcrumbs: FeedbackBreadcrumb[];
}

/** Tier-1 environment metadata stored in `context_json`. */
export interface FeedbackContext {
  url: string;
  route?: string;
  tab?: string;
  appVersion?: string;
  timestamp: string;
  browser?: string;
  os?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  referrer?: string;
  rayId?: string;
  breadcrumbCount?: number;
}

/** Redact every string field of a capture bundle (returns a new object). */
export function redactCaptureBundle(bundle: FeedbackCaptureBundle): FeedbackCaptureBundle {
  return {
    console: bundle.console.map(e => ({ ...e, message: redactSensitive(e.message) })),
    network: bundle.network.map(e => ({ ...e, url: redactSensitive(e.url) })),
    breadcrumbs: bundle.breadcrumbs.map(e => ({ ...e, detail: redactSensitive(e.detail) })),
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const FeedbackTypeSchema = z.enum(FEEDBACK_TYPES);
export const FeedbackSeveritySchema = z.enum(FEEDBACK_SEVERITIES);
export const FeedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export const FeedbackPrioritySchema = z
  .number()
  .int()
  .min(FEEDBACK_PRIORITY_MIN)
  .max(FEEDBACK_PRIORITY_MAX);

/** The submit payload (the non-file fields; screenshots + capture arrive as multipart parts). */
export const CreateFeedbackSchema = z.object({
  type: FeedbackTypeSchema,
  severity: FeedbackSeveritySchema.optional(),
  title: z.string().min(1).max(FEEDBACK_TITLE_MAX_LENGTH),
  description: z.string().min(1).max(FEEDBACK_DESCRIPTION_MAX_LENGTH),
  steps: z.string().max(FEEDBACK_FIELD_MAX_LENGTH).optional(),
  expected: z.string().max(FEEDBACK_FIELD_MAX_LENGTH).optional(),
  actual: z.string().max(FEEDBACK_FIELD_MAX_LENGTH).optional(),
  /** Optional free-text submitter metadata (NOT an identity claim). */
  submitterEmail: z.string().max(FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH).optional(),
  submitterName: z.string().max(FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH).optional(),
  /** Tier-1 environment metadata (validated loosely; server re-stamps server-known fields). */
  context: z.record(z.string(), z.unknown()).optional(),
});
export type CreateFeedbackInput = z.infer<typeof CreateFeedbackSchema>;

/** The triage patch (admin-only). All fields optional; at least one applied. */
export const TriageFeedbackSchema = z.object({
  status: FeedbackStatusSchema.optional(),
  priority: FeedbackPrioritySchema.optional(),
  severity: FeedbackSeveritySchema.optional(),
  type: FeedbackTypeSchema.optional(),
  labels: z.string().max(FEEDBACK_TRIAGE_FIELD_MAX_LENGTH).nullable().optional(),
  area: z.string().max(FEEDBACK_TRIAGE_FIELD_MAX_LENGTH).nullable().optional(),
  assignee: z.string().max(FEEDBACK_TRIAGE_FIELD_MAX_LENGTH).nullable().optional(),
  triageNotes: z.string().max(FEEDBACK_TRIAGE_FIELD_MAX_LENGTH).nullable().optional(),
  linkedPr: z.string().max(FEEDBACK_TRIAGE_FIELD_MAX_LENGTH).nullable().optional(),
  externalRef: z.string().max(FEEDBACK_TRIAGE_FIELD_MAX_LENGTH).nullable().optional(),
});
export type TriageFeedbackInput = z.infer<typeof TriageFeedbackSchema>;

/** Reject an empty triage patch ({}) — a no-op that would phantom-bump updatedAt. */
export const TriageFeedbackRequestSchema = TriageFeedbackSchema.refine(
  data => Object.keys(data).length > 0,
  { message: 'at least one field must be provided' },
);

/** A full feedback row as returned by the API / MCP (camelCase, context parsed). */
export interface FeedbackItem {
  id: string;
  shortId: string;
  type: FeedbackType;
  severity: FeedbackSeverity | null;
  priority: number;
  status: FeedbackStatus;
  title: string;
  description: string;
  steps: string | null;
  expected: string | null;
  actual: string | null;
  context: FeedbackContext | null;
  screenshotKeys: string[];
  captureKey: string | null;
  labels: string | null;
  area: string | null;
  assignee: string | null;
  triageNotes: string | null;
  linkedPr: string | null;
  externalRef: string | null;
  submitterEmail: string | null;
  submitterName: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** Query filters for listing feedback. */
export interface FeedbackListParams {
  status?: FeedbackStatus;
  type?: FeedbackType;
  priority?: number;
  since?: string;
  limit?: number;
  offset?: number;
}
