/**
 * Feedback API (v1.26.0) — the AI-actionable feedback work-queue.
 *
 * Mounted at /api/feedback inside adminRoutes, so it inherits the admin-domain
 * restriction + CORS + ADMIN_API_KEY auth chain. There is NO multi-user auth —
 * a single ADMIN_API_KEY gates everything. So:
 *
 *  - The single authenticated admin sees ALL feedback (no submitter-scoping).
 *  - `submitter_email` / `submitter_name` are OPTIONAL free-text metadata typed
 *    into the dialog, NOT identity claims from auth. There are no actor roles.
 *
 * Endpoint set (all behind the parent ADMIN_API_KEY middleware):
 *  - POST   /api/feedback                       submit (multipart)
 *  - GET    /api/feedback                        list (all)
 *  - GET    /api/feedback/:id                    get one
 *  - GET    /api/feedback/:id/attachment/:key    serve bytes (key must belong to item)
 *  - PATCH  /api/feedback/:id                    triage
 *  - DELETE /api/feedback/:id                    delete (cascades R2)
 *  - GET    /api/feedback/export                 md | json export
 *
 * Artifacts (screenshots + capture bundle) live in a dedicated R2 bucket the
 * self-hoster creates and binds as FEEDBACK_BUCKET, under feedback/{id}/.
 * Console/network captures are credential-redacted before storage. Rate limiting
 * is handled by Cloudflare WAF (not in-Worker).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import {
  FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES,
  FEEDBACK_DESCRIPTION_MAX_LENGTH,
  FEEDBACK_FIELD_MAX_LENGTH,
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  FeedbackSeveritySchema,
  FeedbackStatusSchema,
  FeedbackTypeSchema,
  TriageFeedbackRequestSchema,
  redactCaptureBundle,
  redactSensitive,
  sanitizeFeedbackText,
  uuidv7,
  type FeedbackCaptureBundle,
  type FeedbackContext,
  type FeedbackItem,
} from '@bifrost/shared';
import type { AppEnv } from '../types';
import {
  createFeedback,
  deleteFeedback,
  getFeedbackById,
  listFeedback,
  triageFeedback,
  type ListFeedbackFilters,
} from '../db/feedback';
import { recordAuditLog } from '../db/analytics';
import type { AuditAction } from '@bifrost/shared';

export const feedbackRoutes = new Hono<AppEnv>();

const ALLOWED_SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_CONTEXT_BYTES = 16 * 1024; // generous cap on the Tier-1 context blob

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Actor info from Tailscale headers (mirrors storage.ts / admin.ts). */
function getActorInfo(c: { req: { header: (name: string) => string | undefined } }): {
  login: string;
  name: string | null;
} {
  const login = c.req.header('Tailscale-User-Login') || 'api-key';
  const name = c.req.header('Tailscale-User-Name') || null;
  return { login, name };
}

/** The R2 bucket binding, or a clean 500 if it is missing. */
function feedbackBucket(c: Context<AppEnv>): R2Bucket {
  const bucket = c.env.FEEDBACK_BUCKET;
  if (!bucket) {
    throw new HTTPException(500, {
      message: 'Feedback storage is not configured (FEEDBACK_BUCKET missing)',
    });
  }
  return bucket;
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function auditFeedback(
  c: Context<AppEnv>,
  action: AuditAction,
  item: FeedbackItem,
  extra?: Record<string, unknown>,
): void {
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'feedback',
        action,
        actorLogin: actor.login,
        actorName: actor.name,
        path: item.shortId,
        details: JSON.stringify({ id: item.id, shortId: item.shortId, type: item.type, ...extra }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (tests) — skip audit logging.
  }
}

// ---------------------------------------------------------------------------
// POST /api/feedback — submit (multipart)
// ---------------------------------------------------------------------------
feedbackRoutes.post('/', async c => {
  const bucket = feedbackBucket(c);

  // Reject an oversized body BEFORE buffering the multipart payload (≤ 3
  // screenshots + capture + context + headroom). Bounds memory pressure.
  const MAX_BODY_BYTES =
    FEEDBACK_MAX_SCREENSHOTS * FEEDBACK_SCREENSHOT_MAX_BYTES +
    FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES +
    MAX_CONTEXT_BYTES +
    64 * 1024;
  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: 'feedback submission too large' });
  }

  const body = await c.req.parseBody({ all: true });

  // ====================================================================
  // Validate EVERYTHING before any R2 write — a rejected submission must
  // never leave orphaned artifacts in the bucket.
  // ====================================================================

  // --- Required text fields (sanitised, length-validated — reject, not clamp) ---
  const title = sanitizeFeedbackText(field(body.title), Number.MAX_SAFE_INTEGER);
  const description = sanitizeFeedbackText(field(body.description), Number.MAX_SAFE_INTEGER);
  if (!title || !description) {
    throw new HTTPException(400, { message: 'title and description are required' });
  }
  if (title.length > FEEDBACK_TITLE_MAX_LENGTH) {
    throw new HTTPException(400, {
      message: `title must be at most ${FEEDBACK_TITLE_MAX_LENGTH} characters`,
    });
  }
  if (description.length > FEEDBACK_DESCRIPTION_MAX_LENGTH) {
    throw new HTTPException(400, {
      message: `description must be at most ${FEEDBACK_DESCRIPTION_MAX_LENGTH} characters`,
    });
  }

  // --- Enums ---
  const typeParsed = FeedbackTypeSchema.safeParse(field(body.type));
  if (!typeParsed.success) {
    throw new HTTPException(400, {
      message: 'type must be one of bug | feature | question | other',
    });
  }
  let severity: FeedbackItem['severity'] = null;
  const severityRaw = field(body.severity);
  if (severityRaw) {
    const sevParsed = FeedbackSeveritySchema.safeParse(severityRaw);
    if (!sevParsed.success) {
      throw new HTTPException(400, {
        message: 'severity must be one of low | medium | high | critical',
      });
    }
    severity = sevParsed.data;
  }

  // --- Optional structured fields ---
  const steps = sanitizeFeedbackText(field(body.steps), FEEDBACK_FIELD_MAX_LENGTH);
  const expected = sanitizeFeedbackText(field(body.expected), FEEDBACK_FIELD_MAX_LENGTH);
  const actual = sanitizeFeedbackText(field(body.actual), FEEDBACK_FIELD_MAX_LENGTH);

  // --- Optional free-text submitter metadata (NOT an identity claim) ---
  const submitterEmail = sanitizeFeedbackText(
    field(body.submitterEmail),
    FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH,
  );
  const submitterName = sanitizeFeedbackText(
    field(body.submitterName),
    FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH,
  );

  // --- Context (client-supplied Tier-1 metadata; guard non-object; redact
  //     url/referrer which can carry tokens; server stamps known fields) ---
  const contextRaw = field(body.context);
  if (contextRaw && byteLength(contextRaw) > MAX_CONTEXT_BYTES) {
    throw new HTTPException(413, { message: 'context metadata too large' });
  }
  let parsedContext: unknown = null;
  if (contextRaw) {
    try {
      parsedContext = JSON.parse(contextRaw);
    } catch {
      parsedContext = null;
    }
  }
  const context: FeedbackContext =
    parsedContext && typeof parsedContext === 'object' && !Array.isArray(parsedContext)
      ? (parsedContext as FeedbackContext)
      : ({ url: '', timestamp: '' } as FeedbackContext);
  if (typeof context.url === 'string') context.url = redactSensitive(context.url);
  if (typeof context.referrer === 'string') context.referrer = redactSensitive(context.referrer);
  context.timestamp = new Date().toISOString();
  if (c.env.VERSION) context.appVersion = c.env.VERSION;
  const rayId = c.req.header('cf-ray');
  if (rayId) context.rayId = rayId;

  // --- Capture bundle: validate size + parse + redact now (write later) ---
  const captureRaw = field(body.capture);
  let safeCapture: FeedbackCaptureBundle | null = null;
  if (captureRaw) {
    if (byteLength(captureRaw) > FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES) {
      throw new HTTPException(413, { message: 'capture bundle exceeds the size limit' });
    }
    try {
      const bundle = JSON.parse(captureRaw) as FeedbackCaptureBundle;
      safeCapture = redactCaptureBundle({
        console: Array.isArray(bundle.console) ? bundle.console : [],
        network: Array.isArray(bundle.network) ? bundle.network : [],
        breadcrumbs: Array.isArray(bundle.breadcrumbs) ? bundle.breadcrumbs : [],
      });
      context.breadcrumbCount = safeCapture.breadcrumbs.length;
    } catch {
      // Malformed capture JSON is non-fatal — drop it, keep the submission.
      safeCapture = null;
    }
  }

  // --- Screenshots: validate count/type/size now (write later) ---
  const rawShots = body.screenshot;
  const shots: File[] = (Array.isArray(rawShots) ? rawShots : rawShots ? [rawShots] : []).filter(
    (s): s is File => s instanceof File,
  );
  if (shots.length > FEEDBACK_MAX_SCREENSHOTS) {
    throw new HTTPException(400, {
      message: `at most ${FEEDBACK_MAX_SCREENSHOTS} screenshots are allowed`,
    });
  }
  for (const shot of shots) {
    if (shot.size > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      throw new HTTPException(413, { message: 'a screenshot exceeds the 5 MB limit' });
    }
    if (!ALLOWED_SCREENSHOT_TYPES.has(shot.type)) {
      throw new HTTPException(400, { message: 'screenshots must be PNG, JPEG, or WebP' });
    }
  }

  // ====================================================================
  // All inputs valid — write artifacts to R2, then insert. On any failure
  // after a write, delete what we wrote so no orphan is left behind.
  // ====================================================================
  const id = uuidv7();
  const writtenKeys: string[] = [];
  let captureKey: string | null = null;
  const screenshotKeys: string[] = [];
  try {
    if (safeCapture) {
      captureKey = `feedback/${id}/capture.json`;
      await bucket.put(captureKey, JSON.stringify(safeCapture), {
        httpMetadata: { contentType: 'application/json' },
      });
      writtenKeys.push(captureKey);
    }
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const ext = shot.type === 'image/jpeg' ? 'jpg' : shot.type === 'image/webp' ? 'webp' : 'png';
      const key = `feedback/${id}/screenshot-${i}.${ext}`;
      await bucket.put(key, shot.stream(), { httpMetadata: { contentType: shot.type } });
      writtenKeys.push(key);
      screenshotKeys.push(key);
    }

    const item = await createFeedback(c.env.DB, {
      id,
      type: typeParsed.data,
      severity,
      title,
      description,
      steps,
      expected,
      actual,
      context,
      screenshotKeys,
      captureKey,
      submitterEmail,
      submitterName,
    });

    auditFeedback(c, 'feedback_create', item, { type: item.type });
    return c.json({ success: true, data: item }, 201);
  } catch (err) {
    // Best-effort cleanup so a failed insert/write doesn't orphan R2 objects.
    await Promise.all(
      writtenKeys.map(k =>
        bucket.delete(k).catch(() => {
          /* best-effort */
        }),
      ),
    );
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/feedback — list (the single admin sees all)
// ---------------------------------------------------------------------------
feedbackRoutes.get('/', async c => {
  const filters: ListFeedbackFilters = {};

  const statusParsed = FeedbackStatusSchema.safeParse(c.req.query('status'));
  if (statusParsed.success) filters.status = statusParsed.data;
  const typeParsed = FeedbackTypeSchema.safeParse(c.req.query('type'));
  if (typeParsed.success) filters.type = typeParsed.data;
  const priorityRaw = c.req.query('priority');
  if (priorityRaw !== undefined && /^\d+$/.test(priorityRaw)) {
    filters.priority = Number(priorityRaw);
  }
  const since = c.req.query('since');
  if (since) filters.since = since;
  const limitRaw = c.req.query('limit');
  if (limitRaw && /^\d+$/.test(limitRaw)) filters.limit = Number(limitRaw);
  const offsetRaw = c.req.query('offset');
  if (offsetRaw && /^\d+$/.test(offsetRaw)) filters.offset = Number(offsetRaw);

  const items = await listFeedback(c.env.DB, filters);
  return c.json({ success: true, data: { feedback: items, total: items.length } });
});

// ---------------------------------------------------------------------------
// GET /api/feedback/export — md | json
// ---------------------------------------------------------------------------
feedbackRoutes.get('/export', async c => {
  const format = c.req.query('format') === 'md' ? 'md' : 'json';
  const EXPORT_LIMIT = 200;
  const items = await listFeedback(c.env.DB, { limit: EXPORT_LIMIT });
  // Surface truncation so a consumer (human or AI) knows the export is capped.
  const truncated = items.length >= EXPORT_LIMIT;

  if (format === 'json') {
    return c.json({ success: true, data: { feedback: items, total: items.length, truncated } });
  }

  const lines: string[] = ['# Feedback export', ''];
  if (truncated) lines.push(`> Note: capped at the first ${EXPORT_LIMIT} items.`, '');
  for (const it of items) {
    // Strip newlines from the title so it can't inject extra markdown headings.
    lines.push(`## ${it.shortId} — ${it.title.replace(/\n/g, ' ')}`);
    lines.push(
      `- type: ${it.type} | severity: ${it.severity ?? '—'} | priority: ${it.priority} | status: ${it.status}`,
    );
    lines.push(`- submitter: ${it.submitterEmail ?? '—'} | created: ${it.createdAt}`);
    if (it.area) lines.push(`- area: ${it.area}`);
    if (it.linkedPr && /^https?:\/\//i.test(it.linkedPr)) lines.push(`- linked PR: ${it.linkedPr}`);
    lines.push('', it.description, '');
  }
  return c.text(lines.join('\n'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// ---------------------------------------------------------------------------
// GET /api/feedback/:id — get one
// ---------------------------------------------------------------------------
feedbackRoutes.get('/:id', async c => {
  const item = await getFeedbackById(c.env.DB, c.req.param('id'));
  if (!item) {
    throw new HTTPException(404, { message: 'Feedback not found' });
  }
  return c.json({ success: true, data: item });
});

// ---------------------------------------------------------------------------
// GET /api/feedback/:id/attachment/:key — serve bytes (key must belong to item)
// ---------------------------------------------------------------------------
feedbackRoutes.get('/:id/attachment/:key{.+}', async c => {
  const id = c.req.param('id');
  const key = c.req.param('key');
  const item = await getFeedbackById(c.env.DB, id);
  if (!item) {
    throw new HTTPException(404, { message: 'Feedback not found' });
  }
  // The requested key MUST be one this item owns — never an arbitrary bucket read.
  const owned = item.screenshotKeys.includes(key) || item.captureKey === key;
  if (!owned) {
    throw new HTTPException(404, { message: 'Attachment not found for this item' });
  }
  const bucket = feedbackBucket(c);
  const obj = await bucket.get(key);
  if (!obj) {
    throw new HTTPException(404, { message: 'Attachment object missing' });
  }
  const headers = new Headers();
  if (obj.httpMetadata?.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
  headers.set('Content-Length', obj.size.toString());
  headers.set('ETag', obj.etag);
  // Defence-in-depth: never let a browser sniff/execute a stored attachment
  // (the Content-Type is client-declared at upload time). Force a download.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Disposition', 'attachment');
  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------------------
// PATCH /api/feedback/:id — triage
// ---------------------------------------------------------------------------
feedbackRoutes.patch('/:id', async c => {
  const id = c.req.param('id');

  const raw = await c.req.json().catch(() => null);
  const parsed = TriageFeedbackRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: `Invalid triage payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    });
  }

  const existing = await getFeedbackById(c.env.DB, id);
  if (!existing) {
    throw new HTTPException(404, { message: 'Feedback not found' });
  }

  const updated = await triageFeedback(c.env.DB, id, parsed.data);
  if (!updated) {
    throw new HTTPException(500, { message: 'Triage update failed' });
  }
  // Audit only the lifecycle-relevant ENUM changes — never the free-text
  // triage fields (triageNotes/assignee/labels/linkedPr/externalRef), which may
  // carry sensitive analysis. The full record lives in the feedback row.
  auditFeedback(c, 'feedback_triage', updated, {
    status: parsed.data.status,
    priority: parsed.data.priority,
    severity: parsed.data.severity,
    type: parsed.data.type,
  });
  return c.json({ success: true, data: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/feedback/:id — delete (cascades R2 artifacts)
// ---------------------------------------------------------------------------
feedbackRoutes.delete('/:id', async c => {
  const id = c.req.param('id');

  const existing = await getFeedbackById(c.env.DB, id);
  if (!existing) {
    throw new HTTPException(404, { message: 'Feedback not found' });
  }

  // Best-effort R2 cleanup of the item's known artifacts.
  const bucket = c.env.FEEDBACK_BUCKET;
  if (bucket) {
    const keys = [...existing.screenshotKeys];
    if (existing.captureKey) keys.push(existing.captureKey);
    await Promise.all(
      keys.map(k =>
        bucket.delete(k).catch(() => {
          /* best-effort */
        }),
      ),
    );
  }

  await deleteFeedback(c.env.DB, id);
  auditFeedback(c, 'feedback_delete', existing);
  return c.json({ success: true, data: { id, shortId: existing.shortId } });
});
