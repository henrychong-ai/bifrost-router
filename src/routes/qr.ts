/**
 * QR code API (v1.30.0 — ported from upstream v1.54.0, adapted to the
 * plain-Hono / ADMIN_API_KEY structure of this deployment).
 *
 * Mounted at /api/qr inside adminRoutes, so it inherits the domain
 * restriction + CORS + ADMIN_API_KEY auth chain. This deployment is
 * single-operator: there is no per-domain RBAC layer, so the upstream
 * hasDomainAccess checks collapse into domain validation.
 *
 *  - GET    /api/qr             list (filter/paginate)
 *  - POST   /api/qr             create
 *  - GET    /api/qr/from-route  ephemeral SVG for an existing route
 *  - GET    /api/qr/:id/image   rendered SVG (resolves linked route)
 *  - GET    /api/qr/:id         fetch record
 *  - PUT    /api/qr/:id         update
 *  - DELETE /api/qr/:id         delete
 *
 * Serving is AUTHED-ONLY (upstream locked decision): there is NO public image
 * endpoint — image responses carry `Cache-Control: private, no-store` because
 * payloads may embed Wi-Fi credentials / vCard PII.
 *
 * Mutations are audit-logged (qr_create / qr_update / qr_delete) with Wi-Fi
 * credential fields redacted in the audit projection.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  CreateQRInputSchema,
  MAX_QR_PAYLOAD_LENGTH,
  QRCodeSchema,
  QRDesignSchema,
  QR_ID_REGEX,
  QR_PAYLOAD_SCHEMAS,
  QRTypeSchema,
  UpdateQRInputSchema,
  generateQrId,
  renderQrSvg,
  serializePayload,
  type QRCode,
  type QRDesign,
} from '@bifrost/shared';
import type { AppEnv } from '../types';
import { deleteQR, getQR, listQRs, putQR } from '../kv/qr';
import { getRoute } from '../kv/routes';
import { recordAuditLog, type AuditAction } from '../db/analytics';
import { getRequiredDomainFromRequest, getActorInfo } from './request-context';
import type { Context } from 'hono';

export const qrRoutes = new Hono<AppEnv>();

// =============================================================================
// Shared handler plumbing
// =============================================================================

/** Resolve the target domain (X-Domain > ?domain > ADMIN_API_DOMAIN). */
function requireDomain(c: Context<AppEnv>): string {
  const result = getRequiredDomainFromRequest(c);
  if (!result.valid) {
    throw new HTTPException(400, {
      message: result.error || 'Domain is required for this operation',
    });
  }
  return result.domain;
}

/** Fetch a record or throw 404. */
async function requireQR(c: Context<AppEnv>, domain: string, id: string): Promise<QRCode> {
  const record = await getQR(c.env.ROUTES, domain, id);
  if (!record) {
    throw new HTTPException(404, { message: `QR code not found: ${id}` });
  }
  return record;
}

/**
 * linkedRoute must live on the SAME domain as the QR (upstream codex F1):
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
  // Byte length, not char length (upstream codex F2): QR capacity is
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
 * the route still exists (the dynamic-QR contract: re-point the route, never
 * reprint); a missing route falls back to the stored payload.
 */
async function resolveQrContent(c: Context<AppEnv>, record: QRCode): Promise<string> {
  if (record.linkedRoute) {
    const route = await getRoute(c.env.ROUTES, record.linkedRoute.domain, record.linkedRoute.path);
    if (route) {
      return `https://${record.linkedRoute.domain}${route.path}`;
    }
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
  const domain = requireDomain(c);

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
  if (!route) {
    throw new HTTPException(404, {
      message: `No route at ${domain}${parsed.data.path} to encode`,
    });
  }

  const design: QRDesign = QRDesignSchema.parse({
    ...(parsed.data.fg ? { fg: parsed.data.fg } : {}),
    ...(parsed.data.bg ? { bg: parsed.data.bg } : {}),
    ...(parsed.data.size ? { size: parsed.data.size } : {}),
  });

  // Ephemeral: renders inline, writes nothing to KV — "Save as QR Code"
  // persists via POST /api/qr instead.
  return svgResponse(c, renderQrSvg(`https://${domain}${route.path}`, design));
});

qrRoutes.get('/:id/image', async c => {
  const domain = requireDomain(c);
  const record = await requireQR(c, domain, c.req.param('id'));
  const content = await resolveQrContent(c, record);
  return svgResponse(c, renderQrSvg(content, record.design));
});

// =============================================================================
// JSON CRUD (plain-Hono, envelope responses matching the upstream shapes)
// =============================================================================

const ListQuerySchema = z.object({
  type: QRTypeSchema.optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

qrRoutes.get('/', async c => {
  const domain = requireDomain(c);

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
  const domain = requireDomain(c);
  const record = await requireQR(c, domain, c.req.param('id'));
  return c.json({ success: true as const, data: record });
});

qrRoutes.post('/', async c => {
  const domain = requireDomain(c);

  const body = await c.req.json().catch(() => {
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

  const existing = await getQR(c.env.ROUTES, domain, id);
  if (existing) {
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
  auditQr(c, 'qr_create' as AuditAction, domain, record, { qr: redactQrForAudit(record) });

  return c.json({ success: true as const, data: record }, 201);
});

qrRoutes.put('/:id', async c => {
  const domain = requireDomain(c);
  const existing = await requireQR(c, domain, c.req.param('id'));

  const body = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });
  const parsedInput = UpdateQRInputSchema.safeParse(body);
  if (!parsedInput.success) {
    throw new HTTPException(400, {
      message: parsedInput.error.issues[0]?.message ?? 'validation failed',
    });
  }
  const input = parsedInput.data;

  // Type is immutable (upstream locked decision): changing it would silently
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

  const updated = QRCodeSchema.parse({
    ...existing,
    // Explicit '' clears the description (upstream codex F7); undefined
    // preserves it.
    description:
      input.description !== undefined ? input.description || undefined : existing.description,
    tags: input.tags !== undefined ? input.tags : existing.tags,
    payload,
    design: input.design !== undefined ? QRDesignSchema.parse(input.design) : existing.design,
    ...(linkedRoute ? { linkedRoute } : {}),
    updatedAt: Date.now(),
  });
  if (!linkedRoute) {
    delete (updated as { linkedRoute?: unknown }).linkedRoute;
  }

  await putQR(c.env.ROUTES, updated);
  auditQr(c, 'qr_update' as AuditAction, domain, updated, {
    before: redactQrForAudit(existing),
    after: redactQrForAudit(updated),
  });

  return c.json({ success: true as const, data: updated });
});

qrRoutes.delete('/:id', async c => {
  const domain = requireDomain(c);
  const existing = await requireQR(c, domain, c.req.param('id'));

  await deleteQR(c.env.ROUTES, domain, existing.id);
  auditQr(c, 'qr_delete' as AuditAction, domain, existing, { qr: redactQrForAudit(existing) });

  return c.json({ success: true as const, data: { deleted: true as const, id: existing.id } });
});
