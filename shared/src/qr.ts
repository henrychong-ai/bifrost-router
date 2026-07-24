/**
 * QR code contract (v1.54.0) — the single source of truth for the QR feature
 * shared by the Worker backend (KV persistence + /api/qr routes), the MCP
 * server, and the admin dashboard.
 *
 * Holds: the type enum, the per-type payload schemas (discriminated on `type`),
 * the design schema (colors / size / margin / error correction / logo), the
 * stored-record + create/update/list schemas, the payload serializers (raw URI,
 * plain text, WIFI:, MECARD:), and the id helpers.
 *
 * Domain travels via `?domain` / `X-Domain` exactly like routes — NEVER in a
 * request body. QR records live in KV under `qr:{domain}:{id}` (key helpers in
 * `src/kv/schema.ts` alongside `routeKey`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types + limits
// ---------------------------------------------------------------------------

/** The supported QR content types (MVP set). */
export const QR_TYPES = ['url', 'text', 'vcard', 'wifi'] as const;
export type QRType = (typeof QR_TYPES)[number];

/** QR type enum schema. */
export const QRTypeSchema = z.enum(QR_TYPES);

/**
 * User-supplied QR id slug: lowercase alphanumeric + hyphens, must start with
 * an alphanumeric, 3–32 chars. Generated ids ({@link generateQrId}) match too.
 */
export const QR_ID_REGEX = /^[a-z0-9][a-z0-9-]{2,31}$/;

/** Max length of the human-readable description. */
export const QR_DESCRIPTION_MAX_LENGTH = 100;

/** Longest id {@link normalizeQrId} will emit — the QR_ID_REGEX ceiling. */
const QR_ID_MAX_LENGTH = 32;

/**
 * Slugify free text into a valid QR id (v1.58.5) — lowercase, non-alphanumerics
 * collapsed to single hyphens, trimmed, capped at 32 chars.
 *
 * The dashboard normalises as the user types rather than rejecting, matching
 * how route paths and R2 keys are handled: a space is a `%20` in the KV key
 * and in `/api/qr/{id}/image`, so it can never be stored, but making the user
 * discover that through a validation error is needless friction.
 *
 * Returns '' for input with no usable characters. Output shorter than the
 * regex's 3-char floor is returned as-is so the schema reports it precisely,
 * rather than this function inventing padding.
 */
export function normalizeQrId(input: string): string {
  return normalizeQrIdInput(input).replace(/-+$/, '');
}

/**
 * Typing-friendly variant for CONTROLLED INPUTS (v1.58.8 fix): identical to
 * {@link normalizeQrId} except it does NOT strip a trailing hyphen. A
 * controlled input that re-bases on the fully-normalised value eats the
 * hyphen the moment it is typed (the end of the string is exactly where a
 * user types kebab-case), making hyphens impossible to enter. Use this on
 * every keystroke; apply the full normalizeQrId on blur and at submit so the
 * stored id never carries a trailing separator.
 */
export function normalizeQrIdInput(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, QR_ID_MAX_LENGTH);
}
/** Max number of tags per QR code. */
export const QR_MAX_TAGS = 10;
/** Max length of a single tag. */
export const QR_TAG_MAX_LENGTH = 30;
/** Max length of the SERIALIZED payload string (post-serialization check). */
export const MAX_QR_PAYLOAD_LENGTH = 1024;
/** Max decoded size of the embedded logo (100 KB). */
export const QR_LOGO_MAX_BYTES = 102400;

// ---------------------------------------------------------------------------
// Per-type payload schemas
// ---------------------------------------------------------------------------

/**
 * Scheme-bearing URI check — any RFC-3986 scheme passes (https:, mailto:,
 * tel:, sms:, geo:, bitcoin:, ...), not just web URLs.
 */
const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `url` payload — any free-form scheme-bearing URI. */
// All payload schemas are .strict() (v1.54.1 review fix): the QRPayloadSchema
// union is first-match-wins, and non-strict z.object STRIPS unknown keys — a
// vcard payload whose website is a scheme-bearing `url` matched UrlPayloadSchema
// first and silently lost name/phone/org. Strict members make a mismatched
// variant REJECT instead, so the union falls through to the right shape and no
// caller ever loses keys silently.
export const UrlPayloadSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(1024)
      .regex(URI_SCHEME_REGEX, 'URL must be a scheme-bearing URI (e.g. https:, mailto:, tel:)')
      .describe('Target URI encoded in the QR code (any scheme: https:, mailto:, tel:, ...)'),
  })
  .strict();

/** `text` payload — free-form plain text. */
export const TextPayloadSchema = z
  .object({
    text: z.string().min(1).max(800).describe('Plain text encoded in the QR code'),
  })
  .strict();

/**
 * Wi-Fi auth mode (WIFI: `T:` field). Interop doctrine (v1.58.0, researched):
 *  - `WPA` is the wildcard token for EVERY password-secured PERSONAL network —
 *    WPA, WPA2, WPA3/SAE, and transition mode alike. Scanners treat it as
 *    "secured, negotiate the best handshake"; `T:SAE`/`T:WPA3` tokens break
 *    many parsers and must never be emitted.
 *  - `WPA2-EAP` is the ZXing enterprise (802.1X) extension — parsed natively
 *    by Android (incl. WPA3-Enterprise networks, which negotiate client-side);
 *    iOS cannot join enterprise networks from any QR (platform limitation).
 *  - `WEP` is legacy (deprecated 2004) — retained for old-hardware back-compat.
 */
export const WifiAuthSchema = z.enum(['WPA', 'WEP', 'nopass', 'WPA2-EAP']);

/** EAP method for enterprise (802.1X) networks (Android WifiEnterpriseConfig.Eap). */
export const WifiEapMethodSchema = z.enum(['PEAP', 'TTLS', 'TLS', 'PWD']);

/** Phase-2 (inner) auth for enterprise networks (WifiEnterpriseConfig.Phase2). */
export const WifiPhase2Schema = z.enum(['MSCHAPV2', 'GTC', 'PAP']);

/** `wifi` payload — serialized to the WIFI: network-join format. */
export const WifiPayloadSchema = z
  .object({
    ssid: z.string().min(1).max(64).describe('Network SSID'),
    auth: WifiAuthSchema.default('WPA').describe(
      'Authentication type (default: WPA — covers WPA/WPA2/WPA3 personal; WPA2-EAP = enterprise 802.1X, Android-only)',
    ),
    password: z
      .string()
      .max(128)
      .optional()
      .describe('Network password (omit for nopass; optional for WPA2-EAP with eapMethod TLS)'),
    hidden: z.boolean().default(false).describe('Network is hidden (SSID not broadcast)'),
    eapMethod: WifiEapMethodSchema.optional().describe(
      'EAP method (WPA2-EAP only; required for enterprise networks)',
    ),
    phase2: WifiPhase2Schema.optional().describe('Phase-2 inner auth (WPA2-EAP only)'),
    identity: z.string().max(128).optional().describe('Login identity (WPA2-EAP only; required)'),
    anonymousIdentity: z
      .string()
      .max(128)
      .optional()
      .describe('Anonymous outer identity (WPA2-EAP only)'),
  })
  .strict()
  .superRefine((wifi, ctx) => {
    if (wifi.auth === 'WPA2-EAP') {
      if (!wifi.eapMethod) {
        ctx.addIssue({
          code: 'custom',
          path: ['eapMethod'],
          message: 'EAP method is required for enterprise (WPA2-EAP) networks',
        });
      }
      if (!wifi.identity) {
        ctx.addIssue({
          code: 'custom',
          path: ['identity'],
          message: 'Identity is required for enterprise (WPA2-EAP) networks',
        });
      }
      // TLS is certificate-based — password optional; other EAP methods need one.
      if (wifi.eapMethod && wifi.eapMethod !== 'TLS' && !wifi.password) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: 'Password is required for this EAP method',
        });
      }
    } else {
      if (wifi.auth !== 'nopass' && !wifi.password) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: 'Password is required unless auth is "nopass"',
        });
      }
      // Enterprise-only fields are rejected on non-enterprise auth so a
      // mis-set auth can never silently drop identity data from the QR.
      for (const field of ['eapMethod', 'phase2', 'identity', 'anonymousIdentity'] as const) {
        if (wifi[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is only valid when auth is "WPA2-EAP"`,
          });
        }
      }
    }
  });

/** `vcard` payload — serialized to the compact MECARD: contact format. */
export const VcardPayloadSchema = z
  .object({
    name: z.string().min(1).max(128).describe('Contact name'),
    phone: z.string().max(128).optional().describe('Phone number'),
    email: z.string().max(128).optional().describe('Email address'),
    org: z.string().max(128).optional().describe('Organisation'),
    title: z.string().max(128).optional().describe('Job title'),
    url: z.string().max(128).optional().describe('Website URL'),
  })
  .strict();

/** Any valid payload (variant selected by the record's `type`). */
export const QRPayloadSchema = z.union([
  UrlPayloadSchema,
  TextPayloadSchema,
  WifiPayloadSchema,
  VcardPayloadSchema,
]);

/**
 * Per-type payload schema lookup — handlers use this to validate an update
 * payload against the record's EXISTING type (type itself is immutable).
 */
export const QR_PAYLOAD_SCHEMAS: Record<QRType, z.ZodType> = {
  url: UrlPayloadSchema,
  text: TextPayloadSchema,
  wifi: WifiPayloadSchema,
  vcard: VcardPayloadSchema,
};

// ---------------------------------------------------------------------------
// Design schema
// ---------------------------------------------------------------------------

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

// Full-string anchor with a STRICT base64 charset: the URI is injected into
// the renderer's <image href="..."> attribute, so quotes/angle-brackets in an
// unvalidated body would break out of the attribute — script injection in
// DOWNLOADED SVGs (opened standalone, scripts execute; <img> contexts don't).
const LOGO_DATA_URI_REGEX = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decoded byte size of a base64 data URI, computed from the base64 length
 * (3 bytes per 4 chars, minus `=` padding) — no decode allocation.
 */
export function base64DecodedBytes(dataUri: string): number {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * QR rendering options. All fields default, so `QRDesignSchema.parse({})`
 * yields the canonical design. When `logoDataUri` is present the renderer
 * FORCES error correction to 'H' (the logo obscures ~5% of modules).
 */
export const QRDesignSchema = z.object({
  fg: z
    .string()
    .regex(HEX_COLOR_REGEX, 'Color must be a 6-digit hex value (e.g. #000000)')
    .default('#000000')
    .describe('Foreground (module) color as #rrggbb'),
  bg: z
    .string()
    .regex(HEX_COLOR_REGEX, 'Color must be a 6-digit hex value (e.g. #ffffff)')
    .default('#ffffff')
    .describe('Background color as #rrggbb'),
  size: z
    .number()
    .int()
    .min(128)
    .max(2048)
    .default(512)
    .describe('Rendered width/height in pixels'),
  margin: z.number().int().min(0).max(16).default(4).describe('Quiet-zone margin in modules'),
  errorCorrection: z
    .enum(['L', 'M', 'Q', 'H'])
    .default('M')
    .describe('Error correction level (forced to H when a logo is present)'),
  logoDataUri: z
    .string()
    .regex(
      LOGO_DATA_URI_REGEX,
      'Logo must be a base64 data URI (image/png, image/jpeg, or image/svg+xml)',
    )
    .refine(v => base64DecodedBytes(v) <= QR_LOGO_MAX_BYTES, {
      message: `Logo must decode to ${QR_LOGO_MAX_BYTES} bytes (100 KB) or fewer`,
    })
    .optional()
    .describe('Center logo as a base64 data URI (max 100 KB decoded)'),
  // v1.58.0 wide-logo mode: the logo image's intrinsic width/height ratio,
  // computed by the CLIENT when embedding (never user-typed). Ratio > 2 makes
  // the renderer use a WIDE centre window (~50% of QR width, height derived)
  // instead of the square 22% window, so wordmark-style logos (e.g. a
  // 5.3:1 lockup) stay legible. Absent → square window (all pre-v1.58 records
  // render byte-identically).
  logoAspectRatio: z
    .number()
    .min(0.2)
    .max(12)
    .optional()
    .describe('Logo intrinsic aspect ratio (w/h), client-computed at embed time'),
});
export type QRDesign = z.infer<typeof QRDesignSchema>;

// ---------------------------------------------------------------------------
// Record + input schemas
// ---------------------------------------------------------------------------

/**
 * Optional link to an existing route (url-type QRs only). The image endpoint
 * resolves the live short URL `https://{domain}{path}` at render time and
 * falls back to the stored `payload.url` if the route no longer exists.
 */
export const QRLinkedRouteSchema = z.object({
  domain: z.string().min(1).describe('Domain of the linked route'),
  path: z.string().min(1).startsWith('/').describe('Path of the linked route'),
});

const QRDescriptionSchema = z
  .string()
  .max(QR_DESCRIPTION_MAX_LENGTH)
  .describe('Human-readable description for list views');

const QRTagsSchema = z
  .array(z.string().max(QR_TAG_MAX_LENGTH))
  .max(QR_MAX_TAGS)
  .describe(`Tags for filtering (max ${QR_MAX_TAGS}, each max ${QR_TAG_MAX_LENGTH} chars)`);

/**
 * A stored QR record (KV value + API response shape). Payload validity against
 * the declared `type` and the linkedRoute-only-on-url constraint are enforced
 * via superRefine (the payload union alone cannot see the sibling `type`).
 */
export const QRCodeSchema = z
  .object({
    id: z.string().min(1).describe('QR code id (generated or user slug)'),
    domain: z.string().min(1).describe('Owning domain (RBAC scope, same as routes)'),
    type: QRTypeSchema.describe('QR content type (immutable after create)'),
    description: QRDescriptionSchema.optional(),
    tags: QRTagsSchema.optional(),
    payload: QRPayloadSchema.describe('Type-specific payload'),
    design: QRDesignSchema.describe('Rendering options (defaults applied)'),
    linkedRoute: QRLinkedRouteSchema.optional(),
    createdAt: z.number().describe('Creation timestamp (Unix milliseconds)'),
    updatedAt: z.number().describe('Last update timestamp (Unix milliseconds)'),
    createdBy: z.string().describe('Creating actor (user / MCP / API attribution)'),
  })
  .superRefine((record, ctx) => {
    if (!QR_PAYLOAD_SCHEMAS[record.type].safeParse(record.payload).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload'],
        message: `Payload does not match QR type "${record.type}"`,
      });
    }
    if (record.linkedRoute && record.type !== 'url') {
      ctx.addIssue({
        code: 'custom',
        path: ['linkedRoute'],
        message: 'linkedRoute is only valid for url-type QR codes',
      });
    }
  });
export type QRCode = z.infer<typeof QRCodeSchema>;

const createQrCommonFields = {
  id: z
    .string()
    .regex(QR_ID_REGEX, 'Id must be a lowercase slug: [a-z0-9-], 3-32 chars, starting alphanumeric')
    .optional()
    .describe('Optional custom id slug (generated when omitted)'),
  description: QRDescriptionSchema.optional(),
  tags: QRTagsSchema.optional(),
  design: QRDesignSchema.optional().describe('Rendering options (server applies defaults)'),
};

/**
 * Create input — discriminated on `type` so each variant validates its own
 * payload shape (and OpenAPI emits a oneOf). `linkedRoute` exists on the url
 * variant only. Domain travels via `?domain` / `X-Domain`, never in the body.
 */
export const CreateQRInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    payload: UrlPayloadSchema,
    linkedRoute: QRLinkedRouteSchema.optional(),
    ...createQrCommonFields,
  }),
  z.object({ type: z.literal('text'), payload: TextPayloadSchema, ...createQrCommonFields }),
  z.object({ type: z.literal('vcard'), payload: VcardPayloadSchema, ...createQrCommonFields }),
  z.object({ type: z.literal('wifi'), payload: WifiPayloadSchema, ...createQrCommonFields }),
]);
export type CreateQRInput = z.infer<typeof CreateQRInputSchema>;

/**
 * Update input. Explicit optional fields with NO defaults — an omitted field
 * means "leave unchanged", not "reset to default" (same convention as
 * {@link UpdateRouteInputSchema}). `type` is accepted only so the handler can
 * detect a change attempt and reject it (QR_TYPE_IMMUTABLE); `payload` is
 * re-validated against the record's existing type at the handler level via
 * {@link QR_PAYLOAD_SCHEMAS}; `design` is a full replace when provided;
 * `linkedRoute: null` clears the link.
 */
export const UpdateQRInputSchema = z.object({
  type: QRTypeSchema.optional().describe('Must match the existing type (immutable)'),
  description: QRDescriptionSchema.optional(),
  tags: QRTagsSchema.optional(),
  // Transport-loose (v1.54.1 review fix): the strict QRPayloadSchema union is
  // FIRST-MATCH-WINS with key-stripping — a vcard payload whose website is a
  // scheme-bearing `url` matched UrlPayloadSchema first, lost name/phone/etc,
  // and then failed the handler's per-type revalidation, making such vcards
  // uneditable. The handler's QR_PAYLOAD_SCHEMAS[existing.type] check is the
  // authoritative validator, so the wire schema stays a loose record here
  // (same pattern as the MCP tool input schemas).
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Full payload replacement — validated against the existing (immutable) type'),
  design: QRDesignSchema.optional().describe(
    'FULL design replacement — omitted design fields reset to their defaults (fg #000000, bg #ffffff, size 512, margin 4, EC M)',
  ),
  linkedRoute: QRLinkedRouteSchema.nullable()
    .optional()
    .describe('Linked route (url type only; null clears the link)'),
});
export type UpdateQRInput = z.infer<typeof UpdateQRInputSchema>;

/**
 * List query — `z.coerce.number()` on offset/limit (query params arrive as
 * strings). Pagination mirrors GET /api/routes: applied only when `limit` is
 * explicitly provided.
 */
export const QRListQuerySchema = z.object({
  domain: z.string().optional().describe('Filter by domain'),
  type: QRTypeSchema.optional().describe('Filter by QR type'),
  tag: z.string().optional().describe('Filter by tag (exact match)'),
  search: z.string().optional().describe('Filter by description substring (case-insensitive)'),
  offset: z.coerce.number().min(0).default(0).describe('Pagination offset'),
  limit: z.coerce.number().min(1).max(1000).optional().describe('Results per page'),
});
export type QRListQuery = z.infer<typeof QRListQuerySchema>;

// Inferred payload types
export type QRUrlPayload = z.infer<typeof UrlPayloadSchema>;
export type QRTextPayload = z.infer<typeof TextPayloadSchema>;
export type QRWifiPayload = z.infer<typeof WifiPayloadSchema>;
export type QRVcardPayload = z.infer<typeof VcardPayloadSchema>;
export type QRPayload = z.infer<typeof QRPayloadSchema>;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Escape the MECARD/WIFI special characters (backslash, semicolon, comma,
 * colon, double-quote) with a leading backslash.
 */
export function escapeMecard(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * Serialize a payload to the string encoded into the QR image:
 *   - url   → the URI verbatim
 *   - text  → the text verbatim
 *   - wifi  → `WIFI:T:{auth};S:{ssid};P:{password};H:true;;`
 *             (P: omitted when nopass; H: omitted when not hidden; WPA2-EAP
 *             additionally emits `E:{eapMethod};PH2:{phase2};A:{anonymousIdentity};I:{identity}`
 *             per the ZXing enterprise extension — Android-only)
 *   - vcard → `MECARD:N:{name};TEL:...;EMAIL:...;ORG:...;TITLE:...;URL:...;;`
 *             (optional fields omitted)
 * Callers must enforce {@link MAX_QR_PAYLOAD_LENGTH} on the result
 * (QR_PAYLOAD_TOO_LARGE).
 */
export function serializePayload(type: QRType, payload: QRPayload): string {
  switch (type) {
    case 'url':
      return (payload as QRUrlPayload).url;
    case 'text':
      return (payload as QRTextPayload).text;
    case 'wifi': {
      const wifi = payload as QRWifiPayload;
      const parts = [`T:${wifi.auth}`, `S:${escapeMecard(wifi.ssid)}`];
      if (wifi.auth === 'WPA2-EAP') {
        if (wifi.eapMethod) parts.push(`E:${escapeMecard(wifi.eapMethod)}`);
        if (wifi.phase2) parts.push(`PH2:${escapeMecard(wifi.phase2)}`);
        if (wifi.anonymousIdentity) parts.push(`A:${escapeMecard(wifi.anonymousIdentity)}`);
        if (wifi.identity) parts.push(`I:${escapeMecard(wifi.identity)}`);
        if (wifi.password) parts.push(`P:${escapeMecard(wifi.password)}`);
      } else if (wifi.auth !== 'nopass') {
        parts.push(`P:${escapeMecard(wifi.password ?? '')}`);
      }
      if (wifi.hidden) parts.push('H:true');
      return `WIFI:${parts.join(';')};;`;
    }
    case 'vcard': {
      const vcard = payload as QRVcardPayload;
      const parts = [`N:${escapeMecard(vcard.name)}`];
      if (vcard.phone) parts.push(`TEL:${escapeMecard(vcard.phone)}`);
      if (vcard.email) parts.push(`EMAIL:${escapeMecard(vcard.email)}`);
      if (vcard.org) parts.push(`ORG:${escapeMecard(vcard.org)}`);
      if (vcard.title) parts.push(`TITLE:${escapeMecard(vcard.title)}`);
      if (vcard.url) parts.push(`URL:${escapeMecard(vcard.url)}`);
      return `MECARD:${parts.join(';')};;`;
    }
  }
}

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

/** Generate a 12-char lowercase hex id (always matches {@link QR_ID_REGEX}). */
export function generateQrId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// =============================================================================
// MCP tool input schemas (v1.54.0) — zod shapes consumed by BOTH MCP servers
// (src/mcp/server.ts registers `.shape`; the stdio package validates args).
// Deliberately transport-loose on `payload`/`design`: the REST layer re-validates
// with the strict discriminated schemas above, so MCP clients get friendly
// errors from the API rather than double-maintained schema copies.
// =============================================================================

const mcpDomainField = z
  .string()
  .optional()
  .describe('Target domain (e.g., "links.example.com"). Defaults to the client default domain.');

export const ListQrsInputSchema = z.object({
  domain: mcpDomainField,
  type: QRTypeSchema.optional().describe('Filter by QR type'),
  tag: z.string().optional().describe('Filter by exact tag'),
  search: z.string().optional().describe('Case-insensitive substring over description and id'),
  limit: z.number().int().min(1).max(1000).optional().describe('Page size'),
  offset: z.number().int().min(0).optional().describe('Page offset'),
});
export type ListQrsInput = z.infer<typeof ListQrsInputSchema>;

export const GetQrInputSchema = z.object({
  id: z.string().describe('QR code id'),
  domain: mcpDomainField,
});
export type GetQrInput = z.infer<typeof GetQrInputSchema>;

export const CreateQrToolInputSchema = z.object({
  domain: mcpDomainField,
  type: QRTypeSchema.describe('QR type: url, text, vcard, or wifi'),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      'Type-shaped payload: url {url}; text {text}; wifi {ssid, auth WPA|WEP|nopass|WPA2-EAP, password, hidden?, eapMethod? PEAP|TTLS|TLS|PWD, phase2? MSCHAPV2|GTC|PAP, identity?, anonymousIdentity? — enterprise fields WPA2-EAP only}; vcard {name, phone?, email?, org?, title?, url?}',
    ),
  id: z
    .string()
    .optional()
    .describe('Optional slug (^[a-z0-9][a-z0-9-]{2,31}$); generated if omitted'),
  description: z.string().optional().describe('Description shown in list views (max 100 chars)'),
  tags: z.array(z.string()).optional().describe('Up to 10 tags (max 30 chars each)'),
  design: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Design overrides: fg/bg (#rrggbb), size (128-2048), margin (0-16), errorCorrection (L|M|Q|H), logoDataUri, logoAspectRatio (w/h, >2 = wide wordmark window)',
    ),
  linkedRoute: z
    .object({ domain: z.string(), path: z.string() })
    .optional()
    .describe(
      'url-type only: link to a Bifrost route so the QR encodes the short URL (dynamic QR)',
    ),
});
export type CreateQrToolInput = z.infer<typeof CreateQrToolInputSchema>;

export const UpdateQrToolInputSchema = z.object({
  id: z.string().describe('QR code id'),
  domain: mcpDomainField,
  description: z.string().optional().describe('New description'),
  tags: z.array(z.string()).optional().describe('Replacement tag list'),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Replacement payload (validated against the existing type — type itself is immutable)',
    ),
  design: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Replacement design — FULL replacement, omitted fields reset to defaults; when the record has a logo, round-trip logoDataUri AND logoAspectRatio or wide-logo rendering silently resets',
    ),
  clearLinkedRoute: z.boolean().optional().describe('Set true to unlink the route'),
  linkedRoute: z
    .object({ domain: z.string(), path: z.string() })
    .optional()
    .describe('url-type only: link/re-link to a Bifrost route'),
});
export type UpdateQrToolInput = z.infer<typeof UpdateQrToolInputSchema>;

export const DeleteQrInputSchema = z.object({
  id: z.string().describe('QR code id'),
  domain: mcpDomainField,
});
export type DeleteQrInput = z.infer<typeof DeleteQrInputSchema>;

export const GetRouteQrInputSchema = z.object({
  domain: mcpDomainField,
  path: z.string().describe('Route path to encode (e.g., "/linkedin")'),
  fg: z.string().optional().describe('Foreground colour (#rrggbb)'),
  bg: z.string().optional().describe('Background colour (#rrggbb)'),
  size: z.number().int().min(128).max(2048).optional().describe('SVG size in px'),
});
export type GetRouteQrInput = z.infer<typeof GetRouteQrInputSchema>;
