/**
 * QR code contract — the single source of truth for the QR feature
 * shared by the Worker backend (KV persistence + /api/qr routes), the MCP
 * server, and the admin dashboard.
 *
 * Holds: the type enum, the per-type payload schemas (discriminated on `type`),
 * the design schema (colors / size / margin / error correction / logo), the
 * stored-record + create/update/list schemas, the payload serializers (raw URI,
 * plain text, WIFI:, and vCard 3.0 for contact cards since v1.42.0; MECARD
 * escaping is Wi-Fi only), and the id helpers.
 *
 * Domain travels via `?domain` / `X-Domain` exactly like routes — NEVER in a
 * request body. QR records live in KV under `qr:{domain}:{id}` (key helpers in
 * `src/kv/schema.ts` alongside `routeKey`).
 */

import { z } from 'zod';
import { isOptional, isRecord } from './guards.js';
import {
  hasControlCharacter,
  MAX_ROUTE_KEY_BYTES,
  mcpBoolean,
  mcpNumber,
  RoutePathSchema,
  routeKeyBytes,
} from './schemas.js';
import {
  matchesSearchFields,
  type ParsedSearchQuery,
  QR_SEARCH_DESCRIPTION,
  qrSearchFields,
  resolveQuery,
  SEARCH_PARAM_MAX_LENGTH,
} from './search.js';
import { trimEndChars } from './trim-chars.js';
import { SUPPORTED_DOMAINS, SUPPORTED_DOMAINS_LIST } from './types.js';
import { isFilled, vcardFullName, vcardHasName } from './vcard-name.js';

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

/**
 * The `error` of a 404 for a QR code that does not exist (v1.38.0):
 * `{ success: false, error: 'QR_NOT_FOUND', message }`. Only this answer
 * tells the dashboard a code is gone; any other 404 (a proxy, a wrong base
 * URL) is not a deletion.
 */
export const QR_NOT_FOUND_ERROR = 'QR_NOT_FOUND';

/**
 * The `error` of a 409 for a QR code whose stored record cannot be read
 * (v1.38.0): `{ success: false, error: 'QR_RECORD_INVALID', message }`, on a
 * read, an update or a create with its id. The code exists, so this is never
 * a deletion; the recovery is to delete it (DELETE accepts it) and create it
 * again.
 */
export const QR_RECORD_INVALID_ERROR = 'QR_RECORD_INVALID';

/**
 * The `error` of a 409 for a create whose id is already taken by a readable
 * code (v1.38.0): `{ success: false, error: 'QR_ALREADY_EXISTS', message }`.
 * The dashboard, retrying a create whose first answer never arrived, takes it
 * for its own earlier save when the stored code is the one it sent.
 */
export const QR_ALREADY_EXISTS_ERROR = 'QR_ALREADY_EXISTS';

/** The fixed message of a {@link QR_RECORD_INVALID_ERROR} answer. */
export const QR_RECORD_INVALID_MESSAGE =
  'This QR code is stored in a shape that cannot be read. Delete it and create it again.';

/** Longest id {@link normalizeQrId} will emit — the QR_ID_REGEX ceiling. */
const QR_ID_MAX_LENGTH = 32;

/**
 * Slugify free text into a valid QR id — lowercase, non-alphanumerics
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
  // A linear trim (v1.39.0), not the polynomial `/-+$/`
  return trimEndChars(normalizeQrIdInput(input), '-');
}

/**
 * Typing-friendly variant for CONTROLLED INPUTS: identical to
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
/**
 * Largest serialised QR record (UTF-8 bytes) accepted on write (v1.37.2). A
 * QR record is one line of the nightly backup, whose verifier refuses a line
 * over 1 MiB; every field is capped, the logo dominating at about 134 KiB as a
 * data URI, and the whole record is checked as stored.
 */
export const MAX_QR_RECORD_BYTES = 192 * 1024;

/** Max length of every contact-card text field (v1.42.0). */
export const QR_VCARD_FIELD_MAX_LENGTH = 128;
/** Max number of phone numbers on a contact card. */
export const QR_VCARD_MAX_PHONES = 3;
/**
 * Contact-card phone types, each a vCard 3.0 TEL line (see
 * {@link serializeVcard}): `work` is the person's own number, `main` the
 * office line, `cell` a mobile, `fax` a fax.
 */
export const QR_VCARD_PHONE_TYPES = ['work', 'main', 'cell', 'fax'] as const;
export type QRVcardPhoneType = (typeof QR_VCARD_PHONE_TYPES)[number];

/**
 * The parts of a contact card's work address, in vCard ADR order (after the
 * empty post-office box and extended address): one list for the serializer
 * and the dashboard form.
 */
export const VCARD_ADDRESS_PARTS = ['street', 'city', 'region', 'postcode', 'country'] as const;
export type VcardAddressPart = (typeof VCARD_ADDRESS_PARTS)[number];

/** The contact-card text fields other than the website, phones and address. */
const VCARD_TEXT_FIELDS = [
  'firstName',
  'surname',
  'displayName',
  'name',
  'org',
  'title',
  'phone',
  'email',
] as const;

/** The contact-card fields written unescaped (TEL and EMAIL). */
const VCARD_RAW_FIELDS: ReadonlySet<string> = new Set(['phone', 'email']);

/**
 * `value` without its C0 control characters and DEL; with `keepLineBreaks`,
 * CR and LF are kept (a vCard text value escapes them as `\n`).
 */
export function withoutControlCharacters(
  value: string,
  options: { keepLineBreaks?: boolean } = {},
): string {
  let out = '';
  for (const character of value) {
    const lineBreak = character === '\r' || character === '\n';
    if (!hasControlCharacter(character) || (options.keepLineBreaks === true && lineBreak)) {
      out += character;
    }
  }
  return out;
}

/** Whether a vCard text value holds a control character other than CR or LF. */
function hasVcardTextControl(value: string | undefined): boolean {
  if (value === undefined) return false;
  for (const character of value) {
    if (character !== '\r' && character !== '\n' && hasControlCharacter(character)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-type payload schemas
// ---------------------------------------------------------------------------

/**
 * Scheme-bearing URI check — any RFC-3986 scheme passes (https:, mailto:,
 * tel:, sms:, geo:, bitcoin:, ...), not just web URLs.
 */
const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `url` payload — any free-form scheme-bearing URI. */
// All payload schemas are .strict(): the QRPayloadSchema
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
 * Wi-Fi auth mode (WIFI: `T:` field). Interop doctrine (researched):
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

/**
 * The `vcard` payload schema (v1.42.0), built twice: with `write` for create
 * and update bodies ({@link VcardPayloadSchema}), and without it for stored
 * records ({@link parseStoredQR}), which skips the rules a write adds so
 * every record an earlier release wrote through the API still reads. A
 * contact card written straight to KV with a now-known key (firstName,
 * surname, displayName, phones, address) beside the legacy name, or with such
 * a key of the wrong type, is refused. Length and count caps are in both; the
 * stored read ignores them as for every type.
 *
 * Every field is optional text of at most {@link QR_VCARD_FIELD_MAX_LENGTH}
 * characters; at least one name field is required. `name` and `phone` are the
 * legacy (MECARD-era) fields, still accepted on read and write: `name` becomes
 * FN and the given part of N, `phone` a `TEL;TYPE=WORK,VOICE` line.
 *
 * A legacy field beside its replacement is refused on write AND on read: no
 * release writes one, and the editor cannot open one faithfully, so a stored
 * one is unreadable (Delete only) rather than encoded with a guessed
 * precedence. Only a write refuses a blank phone number (a stored one reads,
 * and {@link serializeVcard} leaves it out) and control characters.
 */
function vcardPayloadSchema(write: boolean) {
  const field = (description: string) =>
    z.string().max(QR_VCARD_FIELD_MAX_LENGTH).optional().describe(description);
  const phoneNumber = z.string().max(QR_VCARD_FIELD_MAX_LENGTH).describe('Phone number');
  const phoneEntry = z
    .object({
      number: write ? phoneNumber.min(1) : phoneNumber,
      type: z
        .enum(QR_VCARD_PHONE_TYPES)
        .describe("work = the person's own number; main = the office line; cell = mobile; fax"),
    })
    .strict();
  return z
    .object({
      firstName: field('First (given) name'),
      surname: field('Surname (family name)'),
      displayName: field('Name as shown on the contact (FN); default "First Surname"'),
      name: field('Legacy full name: becomes FN and the given part of N'),
      org: field('Company (ORG)'),
      title: field('Job title (TITLE)'),
      phones: z
        .array(phoneEntry)
        .max(QR_VCARD_MAX_PHONES)
        .optional()
        .describe(`Up to ${QR_VCARD_MAX_PHONES} phone numbers, each {number, type}`),
      phone: field('Legacy single phone number: becomes TEL;TYPE=WORK,VOICE'),
      email: field('Email address'),
      url: field('Website; a bare domain is encoded as https://<domain>'),
      address: z
        .object({
          street: field('Street (the lines before the town)'),
          city: field('Town or city'),
          region: field('Region or state'),
          postcode: field('Postcode'),
          country: field('Country'),
        })
        .strict()
        .optional()
        .describe('Work address (ADR;TYPE=WORK)'),
    })
    .strict()
    .superRefine((card, ctx) => {
      const names = vcardHasName(card);
      // A stored legacy name is a name when it is any non-empty text: the
      // MECARD-era write rule was min(1), untrimmed, so a blank one was
      // written and must stay readable. A write needs a filled one.
      const legacyName = write ? isFilled(card.name) : (card.name ?? '') !== '';
      if (!names && !legacyName) {
        ctx.addIssue({
          code: 'custom',
          path: ['firstName'],
          message: 'A contact card needs a first name, surname, or display name',
        });
      }
      // A legacy field cannot be combined with the fields that replace it, on
      // read as on write: no release writes such a record (every write
      // refuses it), and the editor cannot open one faithfully, so it reads
      // as unreadable (Delete only) rather than re-encoded with a guessed
      // precedence.
      if (names && isFilled(card.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: 'name (legacy) cannot be combined with firstName, surname, or displayName',
        });
      }
      if (isFilled(card.phone) && (card.phones ?? []).some(phone => isFilled(phone.number))) {
        ctx.addIssue({
          code: 'custom',
          path: ['phone'],
          message: 'phone (legacy) cannot be combined with phones',
        });
      }
      // The rest are write rules only: earlier releases accepted any text, and
      // the serializer drops control characters from a stored record.
      if (!write) return;
      // The website is written unescaped, so a line break would end the line
      if (card.url !== undefined && hasControlCharacter(card.url)) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'Website must not contain line breaks or control characters',
        });
      }
      // Text values: no control characters but CR and LF (escaped as \n).
      // Phone numbers and email are written unescaped: no line break either.
      const texts: Array<[Array<string | number>, string | undefined]> = [
        ...VCARD_TEXT_FIELDS.map((key): [Array<string | number>, string | undefined] => [
          [key],
          card[key],
        ]),
        ...(card.phones ?? []).map((phone, index): [Array<string | number>, string | undefined] => [
          ['phones', index, 'number'],
          phone.number,
        ]),
        ...VCARD_ADDRESS_PARTS.map((part): [Array<string | number>, string | undefined] => [
          ['address', part],
          card.address?.[part],
        ]),
      ];
      for (const [path, value] of texts) {
        const raw = path[0] === 'phones' || VCARD_RAW_FIELDS.has(String(path[0]));
        if (raw ? value !== undefined && hasControlCharacter(value) : hasVcardTextControl(value)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: raw
              ? 'Phone numbers and email must not contain line breaks or control characters'
              : 'Contact card text must not contain control characters other than line breaks',
          });
        }
      }
      // A phone row needs a number (a blank one would be left out)
      for (const [index, phone] of (card.phones ?? []).entries()) {
        if (!isFilled(phone.number)) {
          ctx.addIssue({
            code: 'custom',
            path: ['phones', index, 'number'],
            message: 'Phone number must not be blank',
          });
        }
      }
    });
}

/** `vcard` payload — serialized to vCard 3.0 (v1.42.0; MECARD before). */
export const VcardPayloadSchema = vcardPayloadSchema(true);

/**
 * The `vcard` payload as stored records are read: {@link VcardPayloadSchema}
 * without its write-only rules (v1.42.0).
 */
export const StoredVcardPayloadSchema = vcardPayloadSchema(false);

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

/**
 * The payload schemas stored records are read with ({@link parseStoredQR}):
 * the write schemas, except a contact card's, whose write-only rules are left
 * out (v1.42.0, {@link StoredVcardPayloadSchema}).
 */
export const STORED_QR_PAYLOAD_SCHEMAS: Record<QRType, z.ZodType> = {
  ...QR_PAYLOAD_SCHEMAS,
  vcard: StoredVcardPayloadSchema,
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
  // Wide-logo mode: the logo image's intrinsic width/height ratio,
  // computed by the CLIENT when embedding (never user-typed). Ratio > 2 makes
  // the renderer use a WIDE centre window (~50% of QR width, height derived)
  // instead of the square 22% window, so wordmark-style logos (e.g. a
  // 5.3:1 lockup) stay legible. Absent → square window (records without a
  // ratio render byte-identically).
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
  // Stored records stay tolerant: a domain later retired from
  // SUPPORTED_DOMAINS must never make an existing record unreadable.
  domain: z.string().min(1).describe('Domain of the linked route'),
  path: z.string().min(1).startsWith('/').describe('Path of the linked route'),
});

/**
 * The link as a create or update body may set it: the domain must be a
 * supported domain. The QR handlers also require it to be the QR code's own
 * domain.
 */
export const QRLinkedRouteInputSchema = QRLinkedRouteSchema.extend({
  domain: z.enum(SUPPORTED_DOMAINS).describe('Domain of the linked route'),
  // The route path rules, and the route key limit (v1.37.2): a linked path is
  // a route path, and the record is a backup line
  path: RoutePathSchema.describe('Path of the linked route'),
}).refine(link => routeKeyBytes(link.domain, link.path) <= MAX_ROUTE_KEY_BYTES, {
  // Measured on the key as lookups build it, after normalisation
  message: 'Route path is too long for this domain',
  path: ['path'],
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

// ---------------------------------------------------------------------------
// Stored records: the tolerant read shape (Worker and dashboard)
// ---------------------------------------------------------------------------

const QR_TYPE_SET: ReadonlySet<unknown> = new Set(QR_TYPES);

/** The payload keys each type defines, from its write schema. */
const QR_PAYLOAD_KEYS: Readonly<Record<QRType, readonly string[]>> = {
  url: Object.keys(UrlPayloadSchema.shape),
  text: Object.keys(TextPayloadSchema.shape),
  wifi: Object.keys(WifiPayloadSchema.shape),
  vcard: Object.keys(VcardPayloadSchema.shape),
};

/** The design keys the renderer reads, from the design schema. */
const QR_DESIGN_KEYS: readonly string[] = Object.keys(QRDesignSchema.shape);

/** The default design (every field's default), parsed once. */
const DEFAULT_QR_DESIGN: Readonly<QRDesign> = Object.freeze(QRDesignSchema.parse({}));

/**
 * The stored design: the write schema with only the logo's decoded-size cap
 * left out. Colours, the logo data-URI pattern, the error-correction level
 * and the size, margin and aspect-ratio ranges are checked as on write.
 */
const StoredQRDesignSchema = QRDesignSchema.extend({
  logoDataUri: z.string().regex(LOGO_DATA_URI_REGEX).optional(),
});

/**
 * The stored record: the record write schema (`QRCodeSchema`'s own fields,
 * `createdBy` required), with the design as above and the payload checked
 * per type on its own (the payload union cannot report a length cap as one).
 */
const StoredQRRecordSchema = z.object({
  ...QRCodeSchema.shape,
  payload: z.record(z.string(), z.unknown()),
  design: StoredQRDesignSchema,
});

/**
 * Whether `value` passes `schema` once length and count caps are ignored: it
 * passes, or every issue is a string length or array size over its maximum.
 * Anything else (a type, a format, an enum, a numeric range, a cross-field
 * rule) still fails.
 */
function passesFormats(schema: z.ZodType, value: unknown): boolean {
  const result = schema.safeParse(value);
  return (
    result.success ||
    result.error.issues.every(
      issue => issue.code === 'too_big' && (issue.origin === 'string' || issue.origin === 'array'),
    )
  );
}

/** The keys of `source` named in `keys` whose value is neither null nor undefined. */
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** A phone entry's fields, from the write schema (v1.42.0). */
const VCARD_PHONE_KEYS: readonly string[] = ['number', 'type'];

/**
 * A stored contact card's nested parts keep only the keys they define
 * (v1.42.0), as the top-level payload does: the address parts, and each phone
 * entry's number and type. Anything that is not an object is left for the
 * schema to refuse.
 */
function normaliseVcardParts(payload: Record<string, unknown>): void {
  const { address, phones } = payload;
  if (isRecord(address)) payload['address'] = pick(address, VCARD_ADDRESS_PARTS);
  if (Array.isArray(phones)) {
    payload['phones'] = phones.map((phone: unknown) =>
      isRecord(phone) ? pick(phone, VCARD_PHONE_KEYS) : phone,
    );
  }
}

/**
 * A stored QR record validated and normalised into the shape every reader
 * expects, or null when it is not one (v1.38.0). The ONE read shape, used by
 * the Worker on every KV read (`src/kv/qr.ts`) and by the dashboard on every
 * QR response ({@link StoredQRCodeSchema}).
 *
 * The write schemas minus their length and count caps: a record written
 * under earlier limits (a longer description, more or longer tags, a longer
 * payload field, a bigger logo) stays readable, and the limits apply only to
 * the fields a write sets. Everything else is checked as on write, from the
 * write schemas themselves: the record's fields and their types (`createdBy`
 * included: a record without it is not readable), the payload of its type
 * (the URI scheme, the Wi-Fi enums and rules, required fields non-empty; a
 * contact card without its write-only rules, v1.42.0), the
 * design (hex colours, the logo data-URI pattern, the error-correction level,
 * the size, margin and aspect-ratio ranges; the renderer writes them into SVG
 * markup), a linked route's `domain` and `path`, and a linked route only on a
 * url code. These formats are the ones every release's write schema has
 * enforced, unchanged since QR codes shipped, and every write went through
 * them, so no record written through the API fails them; the renderer also
 * escapes every attribute value.
 *
 * Normalised first: only the fields a record defines are kept (an unknown
 * top-level field, a payload key the type does not define and an unknown
 * design key are dropped, as is an unknown key in a contact card's address or
 * phone entry, so an update never writes them back); a missing or
 * null `design` or design field takes its default; a Wi-Fi payload without
 * `auth` reads as the write default `WPA`; null optional fields are dropped.
 * Nothing is written back by reading.
 */
export function parseStoredQR(value: unknown): QRCode | null {
  if (!isRecord(value)) return null;
  const { payload, design, linkedRoute, type } = value;
  if (
    !QR_TYPE_SET.has(type) ||
    !isRecord(payload) ||
    !isOptional(design, isRecord) ||
    !isOptional(linkedRoute, isRecord)
  ) {
    return null;
  }
  const recordType = type as QRType;
  const normalisedPayload = pick(payload, QR_PAYLOAD_KEYS[recordType]);
  if (recordType === 'wifi' && normalisedPayload['auth'] === undefined) {
    normalisedPayload['auth'] = 'WPA';
  }
  if (recordType === 'vcard') normaliseVcardParts(normalisedPayload);
  const out: Record<string, unknown> = {
    ...pick(value, ['id', 'domain']),
    type: recordType,
    ...pick(value, ['description', 'tags']),
    payload: normalisedPayload,
    // Missing or null design fields take their defaults
    design: {
      ...DEFAULT_QR_DESIGN,
      ...(isRecord(design) ? pick(design, QR_DESIGN_KEYS) : {}),
    },
    ...(isRecord(linkedRoute)
      ? { linkedRoute: { domain: linkedRoute['domain'], path: linkedRoute['path'] } }
      : {}),
    ...pick(value, ['createdAt', 'updatedAt', 'createdBy']),
  };
  if (
    !passesFormats(StoredQRRecordSchema, out) ||
    !passesFormats(STORED_QR_PAYLOAD_SCHEMAS[recordType], normalisedPayload) ||
    (out['linkedRoute'] !== undefined && recordType !== 'url')
  ) {
    return null;
  }
  // Every field a reader consumes was checked above
  return out as unknown as QRCode;
}

/**
 * {@link parseStoredQR} as a schema, for response validation in the
 * dashboard: a record written under earlier limits passes, as it does on the
 * Worker; anything that is not a QR record fails with one fixed message.
 */
export const StoredQRCodeSchema = z.unknown().transform((value, ctx): QRCode => {
  const record = parseStoredQR(value);
  if (record === null) {
    ctx.addIssue({ code: 'custom', message: 'Not a QR code record' });
    return z.NEVER;
  }
  return record;
});

/**
 * A listing row for a stored QR record that cannot be read (v1.38.0): its
 * domain and id only, flagged `invalid`. Listings include these rows so an
 * operator can find and delete the record (DELETE accepts it); nothing else
 * can be done with one.
 */
export interface InvalidQRRow {
  domain: string;
  id: string;
  invalid: true;
}

/** The only fields an {@link InvalidQRRow} has. */
const INVALID_QR_ROW_FIELDS: ReadonlySet<string> = new Set(['domain', 'id', 'invalid']);

/**
 * Whether a listing row is an {@link InvalidQRRow}: told apart by its SHAPE,
 * the key and the flag with nothing else, never by the `invalid` field alone
 * (v1.38.0).
 */
export function isInvalidQRRow(row: unknown): row is InvalidQRRow {
  return (
    isRecord(row) &&
    row['invalid'] === true &&
    typeof row['domain'] === 'string' &&
    typeof row['id'] === 'string' &&
    Object.keys(row).every(field => INVALID_QR_ROW_FIELDS.has(field))
  );
}

/** {@link isInvalidQRRow} as a schema (dashboard response validation): exactly these fields. */
export const InvalidQRRowSchema = z
  .object({
    domain: z.string(),
    id: z.string(),
    invalid: z.literal(true),
  })
  .strict();

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
    linkedRoute: QRLinkedRouteInputSchema.optional(),
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
  // Transport-loose: the strict QRPayloadSchema union is
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
  linkedRoute: QRLinkedRouteInputSchema.nullable()
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
  search: z.string().max(SEARCH_PARAM_MAX_LENGTH).optional().describe(QR_SEARCH_DESCRIPTION),
  offset: z.coerce.number().min(0).default(0).describe('Pagination offset'),
  limit: z.coerce.number().min(1).max(1000).optional().describe('Results per page'),
});
export type QRListQuery = z.infer<typeof QRListQuerySchema>;

/**
 * The QR list filters: `type` exact, `tag` exact membership, and `search` with
 * the shared matcher (`search.ts`: case and separators ignored, words in any
 * order) over the description, the id and, on a contact card, the person's
 * names (`qrSearchFields`, v1.42.0). One predicate for the Worker's
 * listQRs and the dashboard's QR store, so a code the server would list is
 * the code the dashboard shows. A list parses its `search` once
 * (`parseSearchQuery`) and passes the parsed query for every record.
 */
export function qrMatchesListFilters(
  qr: {
    id: string;
    type: string;
    tags?: string[] | undefined;
    description?: string | undefined;
    payload?: unknown;
  },
  query: {
    type?: string | undefined;
    tag?: string | undefined;
    search?: string | ParsedSearchQuery | null | undefined;
  },
): boolean {
  if (query.type && qr.type !== query.type) return false;
  if (query.tag && !(qr.tags ?? []).includes(query.tag)) return false;
  // No search (missing, blank, or parsed as none): the fields are not built
  const search = resolveQuery(query.search);
  if (!search) return true;
  return matchesSearchFields(qrSearchFields(qr), search);
}

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
 * Escape the WIFI: special characters (backslash, semicolon, comma, colon,
 * double-quote) with a leading backslash. Wi-Fi only since v1.42.0: contact
 * cards are vCard 3.0, escaped with {@link escapeVcardText} (MECARD's `\:`
 * broke website links on phones).
 */
export function escapeMecard(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

const VCARD_TEXT_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  ';': '\\;',
  ',': '\\,',
};

/**
 * Escape a vCard 3.0 text value (RFC 2426 §4): backslash, semicolon, and comma
 * take a leading backslash, and a line break (CRLF, CR, or LF) becomes `\n`.
 */
export function escapeVcardText(value: string): string {
  return value.replace(/\r\n|[\\;,\r\n]/g, match => VCARD_TEXT_ESCAPES[match] ?? '\\n');
}

/** The vCard TEL line prefix of each phone type. */
const VCARD_TEL_TYPES: Readonly<Record<QRVcardPhoneType, string>> = {
  work: 'TEL;TYPE=WORK,VOICE',
  main: 'TEL;TYPE=WORK,MAIN',
  cell: 'TEL;TYPE=CELL',
  fax: 'TEL;TYPE=WORK,FAX',
};

/**
 * A contact-card text value as encoded: control characters other than CR and
 * LF dropped (a stored record may hold them; writes refuse them), then
 * trimmed; absent is empty.
 */
function vcardValue(value: string | undefined): string {
  return withoutControlCharacters(value ?? '', { keepLineBreaks: true }).trim();
}

/**
 * A TEL or EMAIL value as encoded: written unescaped, so EVERY control
 * character is dropped, CR and LF included (a line break would end the line,
 * as in the website), then trimmed.
 */
function vcardRawValue(value: string | undefined): string {
  return withoutControlCharacters(value ?? '').trim();
}

/**
 * The website as encoded: control characters dropped first (a URL value is
 * not escaped, so a line break would end the line), then trimmed, then
 * `https://` added to a value without a `scheme://` (`example.com` →
 * `https://example.com`).
 */
function vcardWebsite(value: string): string {
  const url = withoutControlCharacters(value).trim();
  if (url === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

/**
 * Serialize a contact card to vCard 3.0 (v1.42.0): CRLF line ends, no
 * folding, no line break after `END:VCARD`, text values escaped
 * ({@link escapeVcardText}), the website, TEL, and EMAIL not. Lines in the
 * order phones were tested with: N, FN, ORG, TITLE, TEL…, EMAIL, URL, ADR.
 * Values are trimmed; a blank field is left out.
 *
 *  - N is `surname;given;;;`. The given part is the first name; with neither
 *    a first name nor a surname it is the display name (or the legacy name),
 *    so N is not empty for any card a write accepts. The exception: a stored
 *    legacy card whose name is blank (the MECARD-era schema accepted any
 *    non-empty name) encodes an empty N and FN, as its MECARD did.
 *  - FN is {@link vcardFullName}: the display name, else the legacy name,
 *    else "First Surname".
 *  - Text values have their control characters other than CR and LF dropped
 *    (writes refuse them; a stored record may hold them), then are trimmed.
 *  - TEL and EMAIL values are written unescaped, with every control character
 *    dropped (CR and LF too).
 *  - Phones in the order given. `work` is the person's own number: the first
 *    is `TEL;TYPE=WORK,VOICE,PREF`, any further one `TEL;TYPE=WORK,VOICE`.
 *    `main` is `TEL;TYPE=WORK,MAIN`, `cell` `TEL;TYPE=CELL`, `fax`
 *    `TEL;TYPE=WORK,FAX`. The legacy `phone` is `TEL;TYPE=WORK,VOICE`. A
 *    phone whose number is blank is left out (a write refuses one; a stored
 *    record may hold one).
 *  - ADR is `ADR;TYPE=WORK:;;street;city;region;postcode;country`, written
 *    when any part is filled.
 */
export function serializeVcard(card: QRVcardPayload): string {
  const name = {
    firstName: vcardValue(card.firstName),
    surname: vcardValue(card.surname),
    displayName: vcardValue(card.displayName),
    name: vcardValue(card.name),
  };
  const given = name.firstName || (name.surname ? '' : name.displayName || name.name);
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVcardText(name.surname)};${escapeVcardText(given)};;;`,
    `FN:${escapeVcardText(vcardFullName(name))}`,
  ];
  const org = vcardValue(card.org);
  if (org) lines.push(`ORG:${escapeVcardText(org)}`);
  const title = vcardValue(card.title);
  if (title) lines.push(`TITLE:${escapeVcardText(title)}`);
  const legacyPhone = vcardRawValue(card.phone);
  if (legacyPhone) lines.push(`TEL;TYPE=WORK,VOICE:${legacyPhone}`);
  let preferred = false;
  for (const phone of card.phones ?? []) {
    const number = vcardRawValue(phone.number);
    if (!number) continue;
    let prefix = VCARD_TEL_TYPES[phone.type];
    if (phone.type === 'work' && !preferred) {
      prefix += ',PREF';
      preferred = true;
    }
    lines.push(`${prefix}:${number}`);
  }
  const email = vcardRawValue(card.email);
  if (email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${email}`);
  const url = vcardWebsite(card.url ?? '');
  if (url) lines.push(`URL:${url}`);
  const parts = VCARD_ADDRESS_PARTS.map(part => vcardValue(card.address?.[part]));
  if (parts.some(Boolean)) lines.push(`ADR;TYPE=WORK:;;${parts.map(escapeVcardText).join(';')}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

/**
 * Serialize a payload to the string encoded into the QR image:
 *   - url   → the URI verbatim
 *   - text  → the text verbatim
 *   - wifi  → `WIFI:T:{auth};S:{ssid};P:{password};H:true;;`
 *             (P: omitted when nopass; H: omitted when not hidden; WPA2-EAP
 *             additionally emits `E:{eapMethod};PH2:{phase2};A:{anonymousIdentity};I:{identity}`
 *             per the ZXing enterprise extension — Android-only)
 *   - vcard → vCard 3.0 ({@link serializeVcard}; MECARD before v1.42.0)
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
    case 'vcard':
      return serializeVcard(payload as QRVcardPayload);
    default: {
      const unsupported: never = type;
      throw new Error(`Unsupported QR type: ${String(unsupported)}`);
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
// MCP tool input schemas — the QR half of the shared tool contract. This repo
// ships only the local stdio server, whose low-level SDK `Server` validates
// nothing, so these schemas document the contract while the JSON-Schema catalog
// (shared/src/tools.ts) is what clients actually receive and the handler guards
// in mcp/src/tools/qr.ts are the enforcement. Deliberately transport-loose on
// `payload`/`design`: the REST layer re-validates with the strict discriminated
// schemas above, so MCP clients get friendly errors from the API rather than
// double-maintained schema copies.
// =============================================================================

/**
 * Required, enumerated domain for the QR MCP tools (v1.35.0).
 *
 * There is no default: every QR call names its domain, so a missing one is
 * refused instead of resolving server-side to the API's admin host.
 */
const mcpDomainField = z
  .enum(SUPPORTED_DOMAINS)
  .describe(`Domain namespace the QR belongs to. Required — one of: ${SUPPORTED_DOMAINS_LIST}.`);

/** get_route_qr searches a route table rather than the QR namespace. */
const mcpRouteQrDomainField = z
  .enum(SUPPORTED_DOMAINS)
  .describe(
    `Domain whose route table is searched for the path. Required — one of: ${SUPPORTED_DOMAINS_LIST}.`,
  );

export const ListQrsInputSchema = z.object({
  domain: mcpDomainField,
  type: QRTypeSchema.optional().describe('Filter by QR type'),
  tag: z.string().optional().describe('Filter by exact tag'),
  search: z.string().max(SEARCH_PARAM_MAX_LENGTH).optional().describe(QR_SEARCH_DESCRIPTION),
  limit: mcpNumber(z.number().int().min(1).max(1000)).optional().describe('Page size'),
  offset: mcpNumber(z.number().int().min(0)).optional().describe('Page offset'),
});
export type ListQrsInput = z.infer<typeof ListQrsInputSchema>;

export const GetQrInputSchema = z.object({
  id: z.string().describe('QR code id'),
  domain: mcpDomainField,
});
export type GetQrInput = z.infer<typeof GetQrInputSchema>;

/**
 * The contact-card payload as the MCP tools describe it (v1.42.0) — one
 * source for the Zod tool schemas and the tool catalogue.
 */
export const QR_VCARD_PAYLOAD_DESCRIPTION = `vcard (encoded as vCard 3.0) {firstName?, surname?, displayName? (FN; default "First Surname"), org? (company), title?, phones? [{number, type work|main|cell|fax}] (up to ${QR_VCARD_MAX_PHONES}; work = the person's own number, main = the office line), email?, url? (website; a bare domain gets https://), address? {street?, city?, region?, postcode?, country?}} — at least one of firstName, surname, or displayName; every field at most ${QR_VCARD_FIELD_MAX_LENGTH} characters; legacy name (instead of the name fields) and phone (instead of phones) are still accepted`;

/** The `create_qr` payload description, shared with the tool catalogue. */
export const CREATE_QR_PAYLOAD_DESCRIPTION = `Type-shaped payload: url {url}; text {text}; wifi {ssid, auth WPA|WEP|nopass|WPA2-EAP, password, hidden?, eapMethod? PEAP|TTLS|TLS|PWD, phase2? MSCHAPV2|GTC|PAP, identity?, anonymousIdentity? — enterprise fields WPA2-EAP only}; ${QR_VCARD_PAYLOAD_DESCRIPTION}. The serialised content is at most ${MAX_QR_PAYLOAD_LENGTH} bytes.`;

/** The `update_qr` payload description, shared with the tool catalogue. */
export const UPDATE_QR_PAYLOAD_DESCRIPTION = `Replacement payload, whole (validated against the existing type — type itself is immutable). Shapes as create_qr; ${QR_VCARD_PAYLOAD_DESCRIPTION}`;

export const CreateQrToolInputSchema = z.object({
  domain: mcpDomainField,
  type: QRTypeSchema.describe('QR type: url, text, vcard, or wifi'),
  payload: z.record(z.string(), z.unknown()).describe(CREATE_QR_PAYLOAD_DESCRIPTION),
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
    .object({ domain: z.enum(SUPPORTED_DOMAINS), path: z.string() })
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
  payload: z.record(z.string(), z.unknown()).optional().describe(UPDATE_QR_PAYLOAD_DESCRIPTION),
  design: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Replacement design — FULL replacement, omitted fields reset to defaults; when the record has a logo, round-trip logoDataUri AND logoAspectRatio or wide-logo rendering silently resets',
    ),
  clearLinkedRoute: mcpBoolean().optional().describe('Set true to unlink the route'),
  linkedRoute: z
    .object({ domain: z.enum(SUPPORTED_DOMAINS), path: z.string() })
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
  domain: mcpRouteQrDomainField,
  path: z.string().describe('Route path to encode (e.g., "/linkedin")'),
  fg: z.string().optional().describe('Foreground colour (#rrggbb)'),
  bg: z.string().optional().describe('Background colour (#rrggbb)'),
  size: mcpNumber(z.number().int().min(128).max(2048)).optional().describe('SVG size in px'),
});
export type GetRouteQrInput = z.infer<typeof GetRouteQrInputSchema>;
