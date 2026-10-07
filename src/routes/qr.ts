/**
 * QR code API (v1.30.0), built on the plain-Hono / ADMIN_API_KEY structure of
 * this deployment.
 *
 * Mounted at /api/qr inside adminRoutes, so it inherits the domain
 * restriction + CORS + ADMIN_API_KEY auth chain. This deployment is
 * single-operator: there is no per-domain RBAC layer, so per-domain access
 * checks reduce to domain validation.
 *
 *  - GET    /api/qr             list (filter/paginate)
 *  - POST   /api/qr             create
 *  - GET    /api/qr/from-route  ephemeral SVG for an existing route
 *  - GET    /api/qr/:id/image   rendered SVG (resolves linked route)
 *  - GET    /api/qr/:id         fetch record
 *  - PUT    /api/qr/:id         update
 *  - DELETE /api/qr/:id         delete
 *
 * Serving is AUTHED-ONLY (a locked design decision): there is NO public image
 * endpoint — image responses carry `Cache-Control: private, no-store` because
 * payloads may embed Wi-Fi credentials / vCard PII.
 *
 * Mutations are audit-logged (qr_create / qr_update / qr_delete) with Wi-Fi
 * credential fields redacted in the audit projection.
 */

import {
  CreateQRInputSchema,
  generateQrId,
  MAX_QR_PAYLOAD_LENGTH,
  QR_ID_REGEX,
  QR_NOT_FOUND_ERROR,
  QR_PAYLOAD_SCHEMAS,
  QR_RECORD_INVALID_ERROR,
  QR_RECORD_INVALID_MESSAGE,
  type QRCode,
  QRCodeSchema,
  type QRDesign,
  QRDesignSchema,
  QRTypeSchema,
  renderQrSvg,
  SEARCH_PARAM_MAX_LENGTH,
  serializePayload,
  UpdateQRInputSchema,
} from '@bifrost/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuditAction, recordAuditLog } from '../db/analytics';
import { normalizePath } from '../kv/lookup';
import { deleteQR, getQR, listQRs, parseStoredQR, putQR } from '../kv/qr';
import { getRoute, InvalidStoredRouteError } from '../kv/routes';
import { qrKey } from '../kv/schema';
import type { AppEnv } from '../types';
import { CodedHTTPException } from '../utils/coded-http-exception';
import {
  getActorInfo,
  getDomainOrDefaultFromRequest,
  getRequiredDomainFromRequest,
} from './request-context';

export const qrRoutes = new Hono<AppEnv>();

/**
 * The 404 for a QR code that does not exist (v1.38.0): a fixed JSON body
 * `{ success: false, error: 'QR_NOT_FOUND', message }`, so the dashboard can
 * tell the server's own "not found" (the code is gone) from any other 404.
 */
function qrNotFound(id: string): HTTPException {
  return new CodedHTTPException(404, QR_NOT_FOUND_ERROR, `QR code not found: ${id}`);
}

/**
 * The 409 for a QR code whose stored record cannot be read (v1.38.0): a fixed
 * JSON body `{ success: false, error: 'QR_RECORD_INVALID', message }` on a
 * read, an image, an update and a create with its id. The code exists, so it
 * is never answered as `QR_NOT_FOUND` (which the dashboard takes as a
 * deletion); the recovery is to delete it and create it again.
 */
function qrRecordInvalid(): HTTPException {
  return new CodedHTTPException(409, QR_RECORD_INVALID_ERROR, QR_RECORD_INVALID_MESSAGE);
}

// =============================================================================
// Shared handler plumbing
// =============================================================================

/**
 * Resolve a READ's domain: X-Domain or ?domain (both sent must agree, or 400),
 * else ADMIN_API_DOMAIN.
 */
function readDomain(c: Context<AppEnv>): string {
  const result = getDomainOrDefaultFromRequest(c);
  if (!result.valid) {
    throw new HTTPException(400, { message: result.error });
  }
  return result.domain;
}

/** Resolve a WRITE's domain: X-Domain or ?domain, never a default. */
function requireDomain(c: Context<AppEnv>): string {
  const result = getRequiredDomainFromRequest(c);
  if (!result.valid) {
    throw new HTTPException(400, { message: result.error });
  }
  return result.domain;
}

/** Fetch a record, or throw 404 QR_NOT_FOUND (absent) or 409 QR_RECORD_INVALID (unreadable). */
async function requireQR(c: Context<AppEnv>, domain: string, id: string): Promise<QRCode> {
  const state = await getQR(c.env.ROUTES, domain, id);
  if (state.status === 'missing') throw qrNotFound(id);
  if (state.status === 'invalid') throw qrRecordInvalid();
  return state.value;
}

/**
 * linkedRoute must live on the SAME domain as the QR:
 * allowing a foreign domain would make the render-time fallback an
 * existence oracle for routes on other domains.
 */
function assertSameDomainLink(
  domain: string,
  linkedRoute: { domain: string; path: string } | undefined,
): void {
  if (linkedRoute && linkedRoute.domain !== domain) {
    throw new HTTPException(400, {
      message: `linkedRoute.domain must match the QR domain (${domain})`,
    });
  }
}

/** Enforce the serialized-payload budget (QR density limit). */
function assertPayloadSize(type: QRCode['type'], payload: QRCode['payload']): string {
  const serialized = serializePayload(type, payload);
  // Byte length, not char length: QR capacity is
  // byte-oriented, so multibyte payloads must count at their UTF-8 size.
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_QR_PAYLOAD_LENGTH) {
    throw new HTTPException(400, {
      message: `Serialized payload is ${bytes} bytes (max ${MAX_QR_PAYLOAD_LENGTH})`,
    });
  }
  return serialized;
}

/**
 * The string a QR image encodes. A route-linked QR encodes its short URL when
 * the route exists (the dynamic-QR contract: re-point the route, never
 * reprint), also when its stored record cannot be read (v1.38.0): the route
 * is still there, and its URL is what was printed. Only a missing route falls
 * back to the stored payload.
 */
async function resolveQrContent(c: Context<AppEnv>, record: QRCode): Promise<string> {
  if (record.linkedRoute) {
    const { domain, path } = record.linkedRoute;
    const route = await getRoute(c.env.ROUTES, domain, path);
    if (route.status === 'ok') return `https://${domain}${route.value.path}`;
    // The key's own path, as the lookup normalised it
    if (route.status === 'invalid') return `https://${domain}${normalizePath(path)}`;
  }
  return serializePayload(record.type, record.payload);
}

function svgResponse(c: Context<AppEnv>, svg: string): Response {
  // Authed-only serving: payloads can carry Wi-Fi credentials / vCard PII, so
  // rendered images must never land in shared caches.
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'private, no-store',
  });
}

/**
 * Audit copies of QR records mask Wi-Fi credentials: audit rows are
 * long-lived (they outlive hard-deleted records and feed exports). The mask
 * covers `password` plus the enterprise (WPA2-EAP) `identity` /
 * `anonymousIdentity` — 802.1X usernames are credential-class PII. Only the
 * AUDIT projection is redacted; the record itself stays readable.
 */
function redactQrForAudit(record: QRCode): QRCode {
  if (record.type !== 'wifi') return record;
  const payload = { ...(record.payload as Record<string, unknown>) };
  let changed = false;
  for (const field of ['password', 'identity', 'anonymousIdentity'] as const) {
    if (typeof payload[field] === 'string') {
      payload[field] = '[redacted]';
      changed = true;
    }
  }
  return changed ? ({ ...record, payload } as QRCode) : record;
}

function auditQr(
  c: Context<AppEnv>,
  action: AuditAction,
  domain: string,
  record: QRCode,
  details: Record<string, unknown>,
): void {
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `/qr/${record.id}`,
        details: JSON.stringify({
          id: record.id,
          type: record.type,
          description: record.description,
          ...details,
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // No executionCtx (unit tests via app.request) — audit is best-effort.
  }
}

/**
 * The audit row of a deleted record that could not be read: its id, its KV
 * key and `state: 'invalid'`, never the unreadable value.
 */
function auditInvalidQrDelete(c: Context<AppEnv>, domain: string, id: string): void {
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action: 'qr_delete',
        actorLogin: actor.login,
        actorName: actor.name,
        path: `/qr/${id}`,
        details: JSON.stringify({ id, key: qrKey(domain, id), state: 'invalid' }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // No executionCtx (unit tests via app.request) — audit is best-effort.
  }
}

// =============================================================================
// Ephemeral + image endpoints. Registered BEFORE the :id routes so
// 'from-route' never matches as an id.
// =============================================================================

const FromRouteQuerySchema = z.object({
  domain: z.string().optional(),
  path: z.string().min(1).startsWith('/'),
  fg: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  bg: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  size: z.coerce.number().int().min(128).max(2048).optional(),
});

qrRoutes.get('/from-route', async c => {
  const domain = readDomain(c);

  const parsed = FromRouteQuerySchema.safeParse({
    domain: c.req.query('domain'),
    path: c.req.query('path'),
    fg: c.req.query('fg'),
    bg: c.req.query('bg'),
    size: c.req.query('size'),
  });
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? 'validation failed',
    });
  }

  const route = await getRoute(c.env.ROUTES, domain, parsed.data.path);
  if (route.status === 'missing') {
    throw new HTTPException(404, {
      message: `No route at ${domain}${parsed.data.path} to encode`,
    });
  }
  // A route that cannot be read is refused as every route read refuses it
  if (route.status === 'invalid') throw new InvalidStoredRouteError();

  const design: QRDesign = QRDesignSchema.parse({
    ...(parsed.data.fg ? { fg: parsed.data.fg } : {}),
    ...(parsed.data.bg ? { bg: parsed.data.bg } : {}),
    ...(parsed.data.size ? { size: parsed.data.size } : {}),
  });

  // Ephemeral: renders inline, writes nothing to KV — "Save as QR Code"
  // persists via POST /api/qr instead.
  return svgResponse(c, renderQrSvg(`https://${domain}${route.value.path}`, design));
});

qrRoutes.get('/:id/image', async c => {
  const domain = readDomain(c);
  const record = await requireQR(c, domain, c.req.param('id'));
  const content = await resolveQrContent(c, record);
  return svgResponse(c, renderQrSvg(content, record.design));
});

// =============================================================================
// JSON CRUD (plain-Hono, envelope responses)
// =============================================================================

const ListQuerySchema = z.object({
  type: QRTypeSchema.optional(),
  tag: z.string().optional(),
  // A sanity bound (v1.38.0); matching itself reads the first 200 units
  search: z.string().max(SEARCH_PARAM_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

qrRoutes.get('/', async c => {
  const domain = readDomain(c);

  const parsed = ListQuerySchema.safeParse({
    type: c.req.query('type'),
    tag: c.req.query('tag'),
    search: c.req.query('search'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? 'validation failed',
    });
  }
  const query = parsed.data;

  const { items, total } = await listQRs(c.env.ROUTES, domain, {
    type: query.type,
    tag: query.tag,
    search: query.search,
    offset: query.offset,
    limit: query.limit,
  });

  return c.json({
    success: true as const,
    data: items,
    meta: {
      total,
      count: items.length,
      offset: query.offset,
      limit: query.limit ?? total,
      hasMore: query.offset + items.length < total,
    },
  });
});

qrRoutes.get('/:id', async c => {
  const domain = readDomain(c);
  const record = await requireQR(c, domain, c.req.param('id'));
  return c.json({ success: true as const, data: record });
});

qrRoutes.post('/', async c => {
  const domain = requireDomain(c);

  const body: unknown = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });
  const parsedInput = CreateQRInputSchema.safeParse(body);
  if (!parsedInput.success) {
    throw new HTTPException(400, {
      message: parsedInput.error.issues[0]?.message ?? 'validation failed',
    });
  }
  const input = parsedInput.data;

  const id = input.id ?? generateQrId();
  if (!QR_ID_REGEX.test(id)) {
    throw new HTTPException(400, { message: `QR id must match ${QR_ID_REGEX}` });
  }

  // An unreadable stored record is present too (v1.38.0): never overwritten
  const existing = await getQR(c.env.ROUTES, domain, id);
  if (existing.status === 'invalid') throw qrRecordInvalid();
  if (existing.status === 'ok') {
    throw new HTTPException(409, { message: `QR code already exists: ${id}` });
  }

  assertPayloadSize(input.type, input.payload);
  if (input.type === 'url') {
    assertSameDomainLink(domain, input.linkedRoute);
  }

  const now = Date.now();
  const record = QRCodeSchema.parse({
    id,
    domain,
    type: input.type,
    description: input.description || undefined,
    tags: input.tags,
    payload: input.payload,
    design: QRDesignSchema.parse(input.design ?? {}),
    ...(input.type === 'url' && input.linkedRoute ? { linkedRoute: input.linkedRoute } : {}),
    createdAt: now,
    updatedAt: now,
    createdBy: getActorInfo(c).login,
  });

  await putQR(c.env.ROUTES, record);
  auditQr(c, 'qr_create', domain, record, { qr: redactQrForAudit(record) });

  return c.json({ success: true as const, data: record }, 201);
});

qrRoutes.put('/:id', async c => {
  const domain = requireDomain(c);
  const existing = await requireQR(c, domain, c.req.param('id'));

  const body: unknown = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });
  const parsedInput = UpdateQRInputSchema.safeParse(body);
  if (!parsedInput.success) {
    throw new HTTPException(400, {
      message: parsedInput.error.issues[0]?.message ?? 'validation failed',
    });
  }
  const input = parsedInput.data;

  // Type is immutable (a locked design decision): changing it would silently
  // break every printed copy — create a new QR instead.
  if (input.type !== undefined && input.type !== existing.type) {
    throw new HTTPException(400, {
      message: `QR type cannot change (existing: ${existing.type})`,
    });
  }

  let payload = existing.payload;
  if (input.payload !== undefined) {
    const parsed = QR_PAYLOAD_SCHEMAS[existing.type].safeParse(input.payload);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? `payload does not match type ${existing.type}`,
      });
    }
    payload = parsed.data as QRCode['payload'];
    assertPayloadSize(existing.type, payload);
  }

  let linkedRoute = existing.linkedRoute;
  if (input.linkedRoute !== undefined) {
    if (input.linkedRoute === null) {
      linkedRoute = undefined;
    } else if (existing.type !== 'url') {
      throw new HTTPException(400, {
        message: 'linkedRoute is only valid for url-type QR codes',
      });
    } else {
      assertSameDomainLink(domain, input.linkedRoute);
      linkedRoute = input.linkedRoute;
    }
  }

  // Today's field limits apply to the fields in the patch only (v1.38.0, as
  // for routes): the request schema checked description, tags, design and
  // linkedRoute, and the payload was checked above. A field left out is kept
  // as stored, so a record written under older limits (a longer description,
  // more tags) stays editable; QRCodeSchema would re-apply today's limits to
  // every field. The merged record is built from the fields a record defines
  // and passed through the read shape (`parseStoredQR`), which keeps only the
  // payload keys of the record's type and the known design keys, so an
  // unknown field, top-level or nested, is dropped rather than written back;
  // putQR then checks the record's size.
  const merged: Record<string, unknown> = {
    id: existing.id,
    domain: existing.domain,
    type: existing.type,
    // Explicit '' clears the description; undefined preserves it.
    description:
      input.description !== undefined ? input.description || undefined : existing.description,
    tags: input.tags !== undefined ? input.tags : existing.tags,
    payload,
    design: input.design !== undefined ? QRDesignSchema.parse(input.design) : existing.design,
    linkedRoute,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
    createdBy: existing.createdBy,
  };
  const updated = parseStoredQR(merged);
  if (!updated) {
    throw new HTTPException(400, { message: 'QR code update does not form a valid record' });
  }

  await putQR(c.env.ROUTES, updated);
  auditQr(c, 'qr_update', domain, updated, {
    before: redactQrForAudit(existing),
    after: redactQrForAudit(updated),
  });

  return c.json({ success: true as const, data: updated });
});

qrRoutes.delete('/:id', async c => {
  const domain = requireDomain(c);
  const id = c.req.param('id');
  // One read: the state the delete found (v1.38.0). An unreadable record is
  // deleted too, which is how it is recovered; its audit row names the id and
  // key with `state: 'invalid'`, never the unreadable value.
  const state = await deleteQR(c.env.ROUTES, domain, id);
  if (state.status === 'missing') {
    throw qrNotFound(id);
  }
  if (state.status === 'ok') {
    auditQr(c, 'qr_delete', domain, state.value, { qr: redactQrForAudit(state.value) });
  } else {
    auditInvalidQrDelete(c, domain, id);
  }

  // The deleted record's createdAt names the incarnation removed (v1.38.0):
  // the dashboard hides exactly that one, and never a code re-created later
  // with the same id. An unreadable record has none to name.
  return c.json({
    success: true as const,
    data: {
      deleted: true as const,
      id,
      ...(state.status === 'ok' ? { createdAt: state.value.createdAt } : {}),
    },
  });
});
