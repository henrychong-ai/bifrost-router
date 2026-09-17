/**
 * Zod validation schemas for Bifrost
 *
 * These schemas are used for API request validation and
 * MCP tool input validation.
 */

import { z } from 'zod';
import { SUPPORTED_DOMAINS, SUPPORTED_DOMAINS_LIST, R2_BUCKETS, ALL_R2_BUCKETS } from './types.js';
import { CommentSchema } from './comment.js';

// =============================================================================
// MCP boolean coercion
// =============================================================================
// MCP tool args may arrive as JSON booleans OR as strings (some clients stringify
// every arg). A bare `z.boolean()` — what this template used before — refuses
// every one of those calls, which is SAFE but opaque: the caller gets a type
// error rather than the answer it asked for. `mcpBoolean()` parses the common
// string forms explicitly — "true"/"1"/"yes" → true, "false"/"0"/"no"/"" → false
// (case-insensitive) — and passes real booleans through untouched.
//
// ⚠️ Never reach for `z.coerce.boolean()` here instead: it is JS-truthy, so the
// string "false" would coerce to `true` and an `enabled="false"` call would
// ENABLE the route. Any value `mcpBoolean()` does not recognise (including JSON
// numbers `1`/`0` and unrecognised strings) falls through to `z.boolean()`,
// which rejects it, so a toggle still fails closed rather than guessing.
const mcpBoolean = () =>
  z.preprocess(v => {
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    }
    return v;
  }, z.boolean());

// =============================================================================
// Domain Schema
// =============================================================================

/**
 * Schema for supported domains
 */
export const DomainSchema = z
  .string()
  .optional()
  .refine(val => !val || SUPPORTED_DOMAINS.includes(val as (typeof SUPPORTED_DOMAINS)[number]), {
    message: `Domain must be one of: ${SUPPORTED_DOMAINS.join(', ')}`,
  });

/**
 * Required, enumerated domain for the MCP tool surface (v1.35.0).
 *
 * Every route, QR and slug-stats tool names its own domain: there is no default
 * anywhere in the MCP layer and no environment variable fills one in, so a
 * missing domain is refused rather than silently resolving to some other
 * brand's host. {@link OptionalDomainSchema} is the analytics counterpart
 * (omitted = all domains); the untyped {@link DomainSchema} remains for the
 * REST query schemas.
 */
export const RequiredDomainSchema = z
  .enum(SUPPORTED_DOMAINS)
  .describe(`Domain. Required — one of: ${SUPPORTED_DOMAINS_LIST}.`);

/**
 * Optional, enumerated domain for the three analytics MCP tools (v1.35.0).
 *
 * A SCOPE, never a default: omitting it means all domains. Enumerated so
 * `tools/list` advertises the same choices the catalog does and a client can
 * pick one without guessing. {@link GetSlugStatsInputSchema} is the exception
 * in this family — it uses {@link RequiredDomainSchema}, because the same slug
 * can exist on several domains and an unscoped read merges their clicks.
 */
export const OptionalDomainSchema = z
  .enum(SUPPORTED_DOMAINS)
  .optional()
  .describe(
    `Domain to scope the results to. Omit for all domains. One of: ${SUPPORTED_DOMAINS_LIST}.`,
  );

// =============================================================================
// Route Schemas
// =============================================================================

/**
 * Route type enum schema
 */
export const RouteTypeSchema = z.enum(['redirect', 'proxy', 'r2']);

/**
 * HTTP redirect status code schema
 */
export const RedirectStatusCodeSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(307),
  z.literal(308),
]);

/**
 * R2 bucket name schema
 */
export const R2BucketSchema = z.enum(R2_BUCKETS);

/**
 * A route TARGET, with control characters refused.
 *
 * The WHATWG URL parser STRIPS U+0009 (tab), U+000A and U+000D from anywhere
 * in a URL, including the middle of a query-parameter NAME. So a target whose
 * query reads `to<TAB>ken=LIVE` scans clean against any name predicate and is
 * then served as `?token=LIVE` — the credential guard sees one string and the
 * redirect emits another. Rejecting C0 and DEL at the schema boundary removes
 * the divergence at its source; the guard additionally re-scans the parsed URL.
 *
 * Nothing legitimate needs a control character in a target: a real URL encodes
 * them, and an R2 object key that contains one is already rejected downstream.
 */
// Tested by code point rather than by a regex character class: matching control
// characters is exactly the point here, and a `no-control-regex` suppression
// would read like an oversight rather than the intent.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A route PATH, with `?`, `#` and a re-encoded `%` refused.
 *
 * `normalizePath()` truncates at the first `?` or `#` BEFORE percent-decoding,
 * and then decodes — so it is not idempotent and a stored path can fail to
 * round-trip in two ways:
 *
 *  - `/p%3Fx` decodes to `/p?x`, is stored under that key and LISTED as
 *    `path: "/p?x"`, but any later request quoting the listed value normalises
 *    to `/p` and edits, toggles or deletes a DIFFERENT route;
 *  - `/p%253Fx` decodes ONCE to `/p%3Fx`, clears the check above, and is stored
 *    under `/p%3fx` — whose listed value renormalises to `/p?x` and then `/p`,
 *    leaving the route orphaned and unmanageable.
 *
 * Both are refused by requiring that one decode introduces no delimiter and no
 * further percent-escape. Every management call depends on a path that means
 * the same thing each time it is read.
 */
function decodedPathHasDelimiter(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed encoding — judge the raw form; normalizePath does the same.
  }
  // A `%` surviving one decode is a second encode level: decoding again would
  // change the path, so the value is not normalisation-stable.
  return decoded.includes('?') || decoded.includes('#') || decoded.includes('%');
}

/**
 * Control characters are refused RAW and ONCE-DECODED: `/p%09x` carries no
 * literal control character, but `normalizePath()` decodes it into a tab.
 */
function pathHasControlCharacter(value: string): boolean {
  if (hasControlCharacter(value)) return true;
  try {
    return hasControlCharacter(decodeURIComponent(value));
  } catch {
    return false;
  }
}

export const RoutePathSchema = z
  .string()
  .min(1)
  .startsWith('/')
  // Targets refused C0/DEL from the start; paths did not, so a path holding a
  // tab was stored under a key no request could ever match — the URL parser
  // strips tab, LF and CR from a request URL before routing.
  .refine(value => !pathHasControlCharacter(value), {
    message: 'Route path must not contain control characters',
  })
  .refine(value => !decodedPathHasDelimiter(value), {
    message: 'Route path must not contain ? or #, or a double-encoded %',
  });

export const RouteTargetSchema = z
  .string()
  .min(1)
  .refine(value => !hasControlCharacter(value), {
    message: 'Target must not contain control characters',
  });

/**
 * The operator acknowledgement that unlocks a credential-shaped route target.
 *
 * A route whose TARGET carries a credential-named query parameter puts that
 * value in KV, in `link_clicks.target_url`, and in the `Route matched` log —
 * and hands it to anyone who opens the short link. The write paths refuse such
 * a target with `ROUTE_TARGET_CREDENTIAL` unless this flag is `true`.
 *
 * ⚠️ REQUEST-ONLY. It is never part of a stored route: the stored-shape schemas
 * (`CreateRouteInputSchema`, `UpdateRouteInputSchema`, and the Worker's own
 * `RouteConfigSchema`) deliberately do NOT carry it, and Zod strips it on
 * parse, so it cannot reach KV or a route response.
 */
export const ACKNOWLEDGE_CREDENTIAL_TARGET_DESCRIPTION =
  'Set true only after the human operator has confirmed they want a short link whose target carries a credential-named parameter (the names are returned in the ROUTE_TARGET_CREDENTIAL error). Do not set it on your own initiative; ask the human first.';

export const AcknowledgeCredentialTargetSchema = z
  .boolean()
  .optional()
  .describe(ACKNOWLEDGE_CREDENTIAL_TARGET_DESCRIPTION);

/**
 * The same flag for an MCP TOOL input. `mcpBoolean()` accepts the stringified
 * booleans some clients send; a bare `z.boolean()` answers a Zod type error
 * instead of the guard, so the operator never sees the parameter names they are
 * being asked about.
 */
export const AcknowledgeCredentialTargetToolSchema = mcpBoolean()
  .optional()
  .describe(ACKNOWLEDGE_CREDENTIAL_TARGET_DESCRIPTION);

/**
 * Full route configuration schema (from API response)
 */
export const RouteSchema = z.object({
  path: RoutePathSchema.describe('URL path pattern (e.g., "/github", "/blog/*")'),
  type: RouteTypeSchema.describe('Route handler type'),
  target: RouteTargetSchema.describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP redirect status code'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe(
    'R2 bucket for file serving (R2 only, default: "files")',
  ),
  enabled: z.boolean().optional().default(true).describe('Enable/disable route'),
  createdAt: z.number().describe('Creation timestamp (Unix milliseconds)'),
  updatedAt: z.number().describe('Last update timestamp (Unix milliseconds)'),
});

/**
 * Schema for creating a new route
 */
export const CreateRouteInputSchema = z.object({
  path: RoutePathSchema.describe('URL path pattern starting with /'),
  type: RouteTypeSchema.describe('Route type: redirect, proxy, or r2'),
  target: RouteTargetSchema.describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP status code (301, 302, 307, 308)'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe(
    'R2 bucket for file serving (R2 only, default: "files")',
  ),
  enabled: z.boolean().optional().default(true).describe('Enable/disable route'),
});

/**
 * Schema for updating an existing route
 */
export const UpdateRouteInputSchema = z.object({
  type: RouteTypeSchema.optional().describe('Route type: redirect, proxy, or r2'),
  target: RouteTargetSchema.optional().describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP status code (301, 302, 307, 308)'),
  preserveQuery: z.boolean().optional().describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only)'),
  enabled: z.boolean().optional().describe('Enable/disable route'),
});

// =============================================================================
// Analytics Query Schemas
// =============================================================================

/**
 * Schema for analytics summary query params
 */
export const AnalyticsSummaryQuerySchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

/**
 * Schema for clicks/views list query params
 */
export const AnalyticsListQuerySchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
  limit: z.number().min(1).max(1000).optional().default(100).describe('Results per page'),
  offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
  slug: z.string().optional().describe('Filter clicks by slug'),
  path: z.string().optional().describe('Filter views by path'),
  country: z
    .string()
    .length(2)
    .toUpperCase()
    .optional()
    .describe('Filter by country code (2-letter ISO)'),
});

/**
 * Schema for slug stats query params
 */
export const SlugStatsQuerySchema = z.object({
  slug: z.string().startsWith('/').describe('Link slug starting with /'),
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

// =============================================================================
// MCP Tool Input Schemas
// =============================================================================

/**
 * list_routes tool input schema
 */
export const ListRoutesInputSchema = z.object({
  domain: RequiredDomainSchema.describe(
    `Target domain whose routes are listed (e.g., 'links.example.com'). Required — one of: ${SUPPORTED_DOMAINS_LIST}.`,
  ),
  search: z
    .string()
    .optional()
    .describe(
      'Search term to filter routes. Matches against path, target URL, type, status code, bucket, and host header (case-insensitive).',
    ),
});

/**
 * get_route tool input schema
 */
export const GetRouteInputSchema = z.object({
  path: RoutePathSchema.describe('Route path starting with /'),
  domain: RequiredDomainSchema,
});

/**
 * create_route tool input schema
 */
export const CreateRouteToolInputSchema = z.object({
  path: RoutePathSchema.describe('Route path starting with /'),
  type: RouteTypeSchema.describe('Route type: redirect, proxy, or r2'),
  target: RouteTargetSchema.describe('Target URL or R2 key'),
  statusCode: z.number().optional().describe('HTTP status (301/302/307/308) for redirects'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe(
    'R2 bucket for file serving (R2 only, default: "files")',
  ),
  domain: RequiredDomainSchema,
  acknowledgeCredentialTarget: AcknowledgeCredentialTargetToolSchema,
});

/**
 * update_route tool input schema
 */
export const UpdateRouteToolInputSchema = z.object({
  path: RoutePathSchema.describe('Route path to update'),
  type: RouteTypeSchema.optional().describe('New route type'),
  target: RouteTargetSchema.optional().describe('New target URL or R2 key'),
  statusCode: z.number().optional().describe('New HTTP status code'),
  preserveQuery: z.boolean().optional().describe('New preserve query setting'),
  preservePath: z.boolean().optional().describe('New preserve path setting'),
  cacheControl: z.string().optional().describe('New Cache-Control header'),
  hostHeader: z.string().optional().describe('New Host header override for proxy routes'),
  forceDownload: z.boolean().optional().describe('New force download setting (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only)'),
  domain: RequiredDomainSchema,
  acknowledgeCredentialTarget: AcknowledgeCredentialTargetToolSchema,
});

/**
 * delete_route tool input schema
 */
export const DeleteRouteInputSchema = z.object({
  path: RoutePathSchema.describe('Route path to delete'),
  domain: RequiredDomainSchema,
});

/**
 * toggle_route tool input schema
 */
export const ToggleRouteInputSchema = z.object({
  path: RoutePathSchema.describe('Route path to toggle'),
  // `mcpBoolean()` parses string args correctly: "false" → false. This field was
  // a bare `z.boolean()`, so a stringified argument was refused outright rather
  // than misread — safe, but the caller never learned why. Real booleans pass
  // through; unrecognised values are still rejected.
  enabled: mcpBoolean().describe('Enable (true) or disable (false) the route'),
  domain: RequiredDomainSchema,
  acknowledgeCredentialTarget: AcknowledgeCredentialTargetToolSchema,
});

/**
 * get_analytics_summary tool input schema
 */
export const GetAnalyticsSummaryInputSchema = z.object({
  domain: OptionalDomainSchema,
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

/**
 * get_clicks tool input schema
 */
export const GetClicksInputSchema = z.object({
  domain: OptionalDomainSchema,
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
  limit: z.number().min(1).max(100).optional().default(50).describe('Results per page'),
  offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
  slug: z.string().optional().describe('Filter by specific slug'),
  country: z.string().length(2).optional().describe('Filter by country code'),
});

/**
 * get_views tool input schema
 */
export const GetViewsInputSchema = z.object({
  domain: OptionalDomainSchema,
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
  limit: z.number().min(1).max(100).optional().default(50).describe('Results per page'),
  offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
  path: z.string().optional().describe('Filter by specific path'),
  country: z.string().length(2).optional().describe('Filter by country code'),
});

/**
 * get_slug_stats tool input schema
 */
export const GetSlugStatsInputSchema = z.object({
  slug: z.string().startsWith('/').describe("Link slug (e.g., '/linkedin')"),
  domain: RequiredDomainSchema.describe(
    `Domain the slug belongs to. Required — the same slug can exist on several domains. One of: ${SUPPORTED_DOMAINS_LIST}.`,
  ),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

// =============================================================================
// Routes List Query Schema
// =============================================================================

/**
 * Query parameters for listing routes with search and pagination
 */
export const RoutesListQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(1000).optional(),
  offset: z.coerce.number().min(0).default(0),
  search: z.string().optional(),
  type: z.enum(['redirect', 'proxy', 'r2']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

// =============================================================================
// R2 Storage Schemas
// =============================================================================

export const AllR2BucketSchema = z.enum(ALL_R2_BUCKETS);

export const R2ListObjectsInputSchema = z.object({
  bucket: AllR2BucketSchema.describe('R2 bucket name'),
  prefix: z.string().optional().describe('Filter objects by key prefix'),
  cursor: z.string().optional().describe('Pagination cursor from a previous truncated response'),
  limit: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .describe('Maximum objects to return (default: 100, max: 1000)'),
  delimiter: z.string().optional().describe('Delimiter for directory-like grouping (default: "/")'),
});

export const R2UploadInputSchema = z
  .object({
    bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
    key: z.string().min(1).describe('Object key (path) within the bucket'),
    file_path: z.string().min(1).optional().describe('Absolute path to a local file to upload'),
    content_base64: z
      .string()
      .min(1)
      .optional()
      .describe('Base64-encoded file content (mutually exclusive with file_path)'),
    content_type: z
      .string()
      .min(1)
      .optional()
      .describe('MIME type (auto-detected from key extension if omitted)'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Overwrite if object already exists (default: false)'),
  })
  .refine(data => data.file_path || data.content_base64, {
    message: 'Provide either file_path or content_base64',
  })
  .refine(data => !(data.file_path && data.content_base64), {
    message: 'Provide either file_path or content_base64, not both',
  });

export const R2RenameInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  old_key: z.string().min(1).describe('Current object key (path)'),
  new_key: z.string().min(1).describe('New object key (path)'),
});

export const R2MoveInputSchema = z.object({
  bucket: R2BucketSchema.describe('Source R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key to move'),
  destination_bucket: R2BucketSchema.describe('Destination R2 bucket name (read-write only)'),
  destination_key: z
    .string()
    .optional()
    .describe('New key in destination bucket (defaults to original key)'),
});

export const R2UpdateMetadataInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key (path) to update metadata for'),
  content_type: z.string().optional().describe('New Content-Type'),
  cache_control: z.string().optional().describe('New Cache-Control header'),
  content_disposition: z.string().optional().describe('New Content-Disposition'),
});

/**
 * update_object_comment tool input schema (v1.30.0, ported from upstream
 * v1.58.7). The `comment` field is REQUIRED — send null (or an empty string)
 * to clear the note. Mirrors the explicit-set semantics of
 * PUT /api/storage/:bucket/comment/:key, which rejects a missing field rather
 * than treating absence as "clear".
 */
export const R2UpdateCommentInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key (path) to set the comment on'),
  comment: CommentSchema.nullable().describe(
    'Free-text note/comment for the file (max 1000 chars). Pass null or an empty string to clear.',
  ),
});

export type R2UpdateCommentInput = z.infer<typeof R2UpdateCommentInputSchema>;

export const R2ObjectKeyInputSchema = z.object({
  bucket: AllR2BucketSchema.describe('R2 bucket name'),
  key: z.string().min(1).describe('Object key (path) within the bucket'),
});

export const R2GetObjectInputSchema = z.object({
  bucket: AllR2BucketSchema.describe('R2 bucket name'),
  key: z.string().min(1).describe('Object key (path) within the bucket'),
  metadata_only: z
    .boolean()
    .optional()
    .describe('If true, return only metadata without downloading content (default: false)'),
});

export const R2DeleteObjectInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key (path) to delete'),
});

// =============================================================================
// Inferred Types
// =============================================================================

export type Route = z.infer<typeof RouteSchema>;
export type CreateRouteInput = z.infer<typeof CreateRouteInputSchema>;
export type UpdateRouteInput = z.infer<typeof UpdateRouteInputSchema>;
export type RoutesListQuery = z.infer<typeof RoutesListQuerySchema>;
export type ListRoutesInput = z.infer<typeof ListRoutesInputSchema>;
export type GetRouteInput = z.infer<typeof GetRouteInputSchema>;
export type CreateRouteToolInput = z.infer<typeof CreateRouteToolInputSchema>;
export type UpdateRouteToolInput = z.infer<typeof UpdateRouteToolInputSchema>;
export type DeleteRouteInput = z.infer<typeof DeleteRouteInputSchema>;
export type ToggleRouteInput = z.infer<typeof ToggleRouteInputSchema>;
export type GetAnalyticsSummaryInput = z.infer<typeof GetAnalyticsSummaryInputSchema>;
export type GetClicksInput = z.infer<typeof GetClicksInputSchema>;
export type GetViewsInput = z.infer<typeof GetViewsInputSchema>;
export type GetSlugStatsInput = z.infer<typeof GetSlugStatsInputSchema>;
export type R2ListObjectsInput = z.infer<typeof R2ListObjectsInputSchema>;
export type R2UploadInput = z.infer<typeof R2UploadInputSchema>;
export type R2RenameInput = z.infer<typeof R2RenameInputSchema>;
export type R2MoveInput = z.infer<typeof R2MoveInputSchema>;
export type R2UpdateMetadataInput = z.infer<typeof R2UpdateMetadataInputSchema>;
export type R2ObjectKeyInput = z.infer<typeof R2ObjectKeyInputSchema>;
export type R2GetObjectInput = z.infer<typeof R2GetObjectInputSchema>;
export type R2DeleteObjectInput = z.infer<typeof R2DeleteObjectInputSchema>;

// =============================================================================
// Audit Log Schemas
// =============================================================================

/**
 * Audit action type schema - single source of truth for all audit actions
 */
export const AuditActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'toggle',
  'seed',
  'migrate',
  'transfer',
  'r2_upload',
  'r2_delete',
  'r2_rename',
  'r2_metadata_update',
  'r2_move',
  'r2_replace',
  'r2_cache_purge',
  'r2_comment_update',
  'feedback_create',
  'feedback_triage',
  'feedback_delete',
  // v1.30.0 — QR codes (ported from upstream v1.54.0)
  'qr_create',
  'qr_update',
  'qr_delete',
  // v1.28.0 — external R2 operations audit capture. Kept separate from the
  // semantic r2_* actions above because R2 event notifications cannot
  // distinguish upload vs replace vs move; the raw event action lives in
  // `details`.
  'r2_object_create',
  'r2_object_delete',
  'cf_config_change',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/**
 * Which pipeline recorded an audit entry (v1.28.0):
 *  - 'bifrost'  — Bifrost dashboard/MCP/API write sites (default)
 *  - 'r2_event' — R2 event notification consumer (external object mutations;
 *    no actor identity available at platform level)
 *  - 'cf_audit' — Cloudflare account audit-log poller (control-plane changes
 *    with the real Cloudflare actor)
 */
export const AuditSourceSchema = z.enum(['bifrost', 'r2_event', 'cf_audit']);
export type AuditSource = z.infer<typeof AuditSourceSchema>;

/**
 * Audit log entry schema
 */
export const AuditLogSchema = z.object({
  id: z.number(),
  domain: z.string(),
  action: AuditActionSchema,
  actorLogin: z.string().nullable(),
  actorName: z.string().nullable(),
  path: z.string().nullable(),
  details: z.string().nullable(),
  ipAddress: z.string().nullable(),
  source: AuditSourceSchema,
  createdAt: z.number(),
});
