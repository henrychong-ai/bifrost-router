/**
 * @bifrost/shared
 *
 * Shared code for the Bifrost Worker, dashboard and MCP server
 */

export * from './analytics-utils.js';
// Backup health answer (v1.38.0): one definition for the Worker and the dashboard
export {
  type ArchiveInfo,
  ArchiveInfoSchema,
  type BackupAgeStatus,
  BackupAgeStatusSchema,
  type BackupFileStatus,
  BackupFileStatusSchema,
  type BackupHealthResponse,
  BackupHealthResponseSchema,
  type HealthChecks,
  HealthChecksSchema,
  type HealthIssue,
  HealthIssueSchema,
  type HealthStatus,
  HealthStatusSchema,
  type IssueSeverity,
  IssueSeveritySchema,
  type LastBackupInfo,
  LastBackupInfoSchema,
  type ManifestSummary,
  ManifestSummarySchema,
} from './backup-health.js';
// JSON with sorted keys at every level (v1.38.0): one serialiser for every
// "is this the same value" comparison
export { canonicalJson } from './canonical-json.js';
export type { EdgeRouterClientConfig } from './client.js';
// Client
export {
  createClientFromEnv,
  EdgeRouterClient,
  EdgeRouterError,
} from './client.js';
// File comments (v1.26.0)
export {
  COMMENT_MAX_LENGTH,
  CommentFieldSchema,
  CommentSchema,
  isCommentEmpty,
  sanitizeComment,
} from './comment.js';
// The one reader of a failed answer's body (v1.38.0): the shared client and
// the dashboard; a machine code is an UPPER_SNAKE value only
export {
  type ErrorEnvelope,
  isErrorCode,
  PLAIN_ERROR_MAX_LENGTH,
  plainErrorText,
  readErrorEnvelope,
} from './error-envelope.js';
// Feedback work-queue (v1.26.0)
export {
  type CreateFeedbackInput,
  CreateFeedbackSchema,
  FEEDBACK_AREAS,
  FEEDBACK_CAPTURE_BUNDLE_MAX_BYTES,
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_DESCRIPTION_MAX_LENGTH,
  FEEDBACK_FIELD_MAX_LENGTH,
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_PRIORITIES,
  FEEDBACK_PRIORITY_DEFAULT,
  FEEDBACK_PRIORITY_MAX,
  FEEDBACK_PRIORITY_MIN,
  FEEDBACK_PRIORITY_SCALE_DESCRIPTION,
  FEEDBACK_RATE_LIMIT_PER_MINUTE,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SHORT_ID_PREFIX,
  FEEDBACK_STATUSES,
  FEEDBACK_SUBMITTER_FIELD_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  FEEDBACK_TRIAGE_FIELD_MAX_LENGTH,
  FEEDBACK_TYPES,
  type FeedbackBreadcrumb,
  type FeedbackCaptureBundle,
  FeedbackCaptureBundleSchema,
  type FeedbackConsoleEntry,
  type FeedbackContext,
  FeedbackContextSchema,
  type FeedbackItem,
  type FeedbackListParams,
  type FeedbackNetworkEntry,
  FeedbackPriorityInputSchema,
  FeedbackPrioritySchema,
  type FeedbackStatus,
  FeedbackStatusSchema,
  FeedbackStringListSchema,
  type FeedbackType,
  FeedbackTypeSchema,
  formatFeedbackAge,
  formatFeedbackPriority,
  formatFeedbackShortId,
  REDACTION_PLACEHOLDER,
  redactCaptureBundle,
  redactSensitive,
  sanitizeFeedbackText,
  type TriageFeedbackInput,
  TriageFeedbackRequestSchema,
  TriageFeedbackSchema,
  uuidv7,
} from './feedback.js';
// Plain type guards for values read as unknown (v1.38.0): one definition for
// the Worker, the dashboard and the API client
export { isFiniteNumber, isOptional, isRecord, isString } from './guards.js';
// Link-naming advice (v1.38.0) — advisory warnings for link paths in the
// route and QR dialogs; never blocks a write.
export {
  LINK_NAMING_HINT,
  type LinkNamingIssue,
  type LinkNamingIssueCode,
  linkNamingIssues,
} from './link-naming.js';
// MIME detection
export { EXTENSION_MIME_MAP, getContentTypeFromKey } from './mime.js';
// A route path, slug or object key as URL path segments (v1.39.0), for the
// dashboard and the API client alike
export { objectKeySegments, pathSegments, UNADDRESSABLE_OBJECT_KEY } from './path-segments.js';
// QR codes (v1.30.0) — the QR contract shared
// by the Worker backend, the MCP server, and the admin dashboard: the type
// enum, per-type payload schemas, design schema, stored-record +
// create/update/list schemas, the WIFI:/MECARD: serializers, and id helpers.
export {
  base64DecodedBytes,
  type CreateQRInput,
  CreateQRInputSchema,
  type CreateQrToolInput,
  CreateQrToolInputSchema,
  type DeleteQrInput,
  DeleteQrInputSchema,
  escapeMecard,
  type GetQrInput,
  GetQrInputSchema,
  type GetRouteQrInput,
  GetRouteQrInputSchema,
  generateQrId,
  type InvalidQRRow,
  InvalidQRRowSchema,
  isInvalidQRRow,
  type ListQrsInput,
  // MCP tool input schemas
  ListQrsInputSchema,
  MAX_QR_PAYLOAD_LENGTH,
  MAX_QR_RECORD_BYTES,
  normalizeQrId,
  normalizeQrIdInput,
  parseStoredQR,
  QR_ALREADY_EXISTS_ERROR,
  QR_DESCRIPTION_MAX_LENGTH,
  QR_ID_REGEX,
  QR_LOGO_MAX_BYTES,
  QR_MAX_TAGS,
  QR_NOT_FOUND_ERROR,
  QR_PAYLOAD_SCHEMAS,
  QR_RECORD_INVALID_ERROR,
  QR_RECORD_INVALID_MESSAGE,
  QR_TAG_MAX_LENGTH,
  QR_TYPES,
  type QRCode,
  QRCodeSchema,
  type QRDesign,
  QRDesignSchema,
  QRLinkedRouteInputSchema,
  QRLinkedRouteSchema,
  type QRListQuery,
  QRListQuerySchema,
  type QRPayload,
  QRPayloadSchema,
  type QRTextPayload,
  type QRType,
  QRTypeSchema,
  type QRUrlPayload,
  type QRVcardPayload,
  type QRWifiPayload,
  qrMatchesListFilters,
  StoredQRCodeSchema,
  serializePayload,
  TextPayloadSchema,
  type UpdateQRInput,
  UpdateQRInputSchema,
  type UpdateQrToolInput,
  UpdateQrToolInputSchema,
  UrlPayloadSchema,
  VcardPayloadSchema,
  WifiAuthSchema,
  WifiEapMethodSchema,
  WifiPayloadSchema,
  WifiPhase2Schema,
} from './qr.js';
// QR design presets (v1.30.0) — neutral by default (self-hosters add their
// own), drift-guarded against SUPPORTED_DOMAINS.
export {
  deriveBrandForDomain,
  NEUTRAL_QR_DESIGN,
  QR_BRAND_PRESETS,
  QR_NEUTRAL_DOMAINS,
  type QrBrandPreset,
  uncoveredDomains,
} from './qr-brand-presets.js';
// Shared QR renderer — one renderer, three
// consumers (Worker image endpoint, MCP base64 SVG, dashboard preview and
// downloads). Pure string SVG output; runs identically in Worker + browser.
export {
  LOGO_SIZE_RATIO,
  qrContrastRatio,
  renderQrSvg,
  WIDE_LOGO_MIN_RATIO,
  WIDE_LOGO_WIDTH_RATIO,
} from './qr-render.js';
// R2 key normalization (v1.27.0) — lowercase + kebab-case, shared by the worker
// (write-time enforcement) and the dashboard (clean default + live preview).
export {
  isNormalizedR2Key,
  isServableR2Key,
  normalizeR2Key,
  sanitizeR2Key,
} from './r2-key.js'; // gitleaks:allow
// Schemas - export selectively to avoid conflicts with types.ts
export {
  ACKNOWLEDGE_CREDENTIAL_TARGET_DESCRIPTION,
  AcknowledgeCredentialTargetSchema,
  AcknowledgeCredentialTargetToolSchema,
  // R2 Storage schemas
  AllR2BucketSchema,
  AnalyticsListQuerySchema,
  // Analytics query schemas
  AnalyticsSummaryQuerySchema,
  type AuditAction,
  // Audit log schemas
  AuditActionSchema,
  AuditLogSchema,
  type AuditSource,
  AuditSourceSchema,
  CreateRouteInputSchema,
  type CreateRouteToolInput,
  CreateRouteToolInputSchema,
  type DeleteRouteInput,
  DeleteRouteInputSchema,
  // Domain schemas
  DomainSchema,
  type GetAnalyticsSummaryInput,
  GetAnalyticsSummaryInputSchema,
  type GetClicksInput,
  GetClicksInputSchema,
  type GetRouteInput,
  GetRouteInputSchema,
  type GetSlugStatsInput,
  GetSlugStatsInputSchema,
  type GetViewsInput,
  GetViewsInputSchema,
  ListBucketsInputSchema,
  // Inferred types from schemas (renamed to avoid conflicts)
  type ListRoutesInput,
  // MCP Tool input schemas
  ListRoutesInputSchema,
  MAX_CACHE_CONTROL_LENGTH,
  MAX_HOST_HEADER_LENGTH,
  MAX_ROUTE_KEY_BYTES,
  MAX_ROUTE_RECORD_BYTES,
  MAX_ROUTE_TARGET_LENGTH,
  MigrateRouteToolInputSchema,
  normalizeRoutePath,
  OptionalDomainSchema,
  type R2DeleteObjectInput,
  R2DeleteObjectInputSchema,
  type R2GetObjectInput,
  R2GetObjectInputSchema,
  type R2ListObjectsInput,
  R2ListObjectsInputSchema,
  R2MoveInputSchema,
  R2MoveRequestSchema,
  type R2ObjectKeyInput,
  R2ObjectKeyInputSchema,
  type R2RenameInput,
  R2RenameInputSchema,
  R2RenameRequestSchema,
  R2UpdateCommentInputSchema,
  R2UpdateCommentRequestSchema,
  type R2UpdateMetadataInput,
  R2UpdateMetadataInputSchema,
  R2UpdateMetadataRequestSchema,
  type R2UploadInput,
  R2UploadInputSchema,
  // Routes list query
  RECOVER_INVALID_DESCRIPTION,
  RedirectStatusCodeSchema,
  RequiredDomainSchema,
  RouteCacheControlSchema,
  RouteHostHeaderSchema,
  RoutePathSchema,
  RouteSchema,
  type RoutesListQuery,
  RoutesListQuerySchema,
  RouteTargetSchema,
  // Route schemas
  RouteTypeSchema,
  routeKeyBytes,
  SlugStatsQuerySchema,
  type ToggleRouteInput,
  ToggleRouteInputSchema,
  TransferRouteToolInputSchema,
  UpdateRouteInputSchema,
  type UpdateRouteToolInput,
  UpdateRouteToolInputSchema,
} from './schemas.js';
// Search matcher (v1.38.0) — case- and separator-insensitive word matching
// plus the as-typed check, for route search and relevance order, QR list
// search (Worker + dashboard store), the QR route picker, and Cmd+K.
export {
  capSearchParam,
  LIST_QRS_TOOL_DESCRIPTION,
  LIST_ROUTES_TOOL_DESCRIPTION,
  matchesRouteSearch,
  matchesSearchFields,
  type ParsedSearchQuery,
  parseSearchQuery,
  QR_SEARCH_DESCRIPTION,
  qrSearchFields,
  ROUTE_SEARCH_DESCRIPTION,
  SEARCH_FIELD_MAX_LENGTH,
  SEARCH_PARAM_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MAX_WORDS,
  type SearchableRoute,
  scoreRouteMatch,
  searchAndRankRoutes,
  tokeniseSearchText,
} from './search.js';
// Stored route records (v1.38.0): the one tolerant read shape for the Worker
// guard and the dashboard, and the listing row of an unreadable record
export {
  type InvalidRouteRow,
  InvalidRouteRowSchema,
  isInvalidRouteRow,
  isStoredRoute,
  parseStoredRoute,
  STORED_ROUTE_FIELDS,
  STORED_ROUTE_REQUIRED,
  type StoredRoute,
  StoredRouteSchema,
} from './stored-route.js';
export type {
  JsonSchemaObject,
  JsonSchemaProperty,
  ToolDefinition,
} from './tools.js';
// Tool definitions
export {
  analyticsTools,
  getToolDefinition,
  getToolsByCategory,
  routeTools,
  storageTools,
  toClaudeTools,
  toMCPTools,
  toolCategories,
  toolDefinitions,
} from './tools.js';
// Types
export * from './types.js';
