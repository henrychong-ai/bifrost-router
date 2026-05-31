import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Link clicks analytics table
 *
 * Records each redirect/link click with metadata for analytics.
 * One row per click (event log pattern).
 */
export const linkClicks = sqliteTable('link_clicks', {
  /** Auto-increment primary key */
  id: integer('id').primaryKey({ autoIncrement: true }),

  /** Domain that received the click (e.g., 'example.com') */
  domain: text('domain').notNull(),

  /** Path/slug that was clicked (e.g., '/linkedin') */
  slug: text('slug').notNull(),

  /** Target URL the user was redirected to */
  targetUrl: text('target_url').notNull(),

  /** Query string from the request (e.g., '?utm_source=twitter') */
  queryString: text('query_string'),

  /** HTTP Referer header (where user came from) */
  referrer: text('referrer'),

  /** User-Agent header */
  userAgent: text('user_agent'),

  /** Country code from Cloudflare cf.country (e.g., 'SG') */
  country: text('country'),

  /** City from Cloudflare cf.city (e.g., 'Singapore') */
  city: text('city'),

  /** Cloudflare datacenter code from cf.colo (e.g., 'SIN') */
  colo: text('colo'),

  /** Continent code from cf.continent (e.g., 'AS') */
  continent: text('continent'),

  /** HTTP protocol version from cf.httpProtocol (e.g., 'HTTP/2') */
  httpProtocol: text('http_protocol'),

  /** IANA timezone from cf.timezone (e.g., 'Asia/Singapore') */
  timezone: text('timezone'),

  /** Client IP address from CF-Connecting-IP header */
  ipAddress: text('ip_address'),

  /** Unix timestamp (seconds since epoch) */
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

/**
 * Page views analytics table
 *
 * Records page views for pages served through the edge router.
 * Only tracks HTML responses (not assets like JS, CSS, images).
 */
export const pageViews = sqliteTable('page_views', {
  /** Auto-increment primary key */
  id: integer('id').primaryKey({ autoIncrement: true }),

  /** Domain that received the view */
  domain: text('domain').notNull(),

  /** Path that was viewed */
  path: text('path').notNull(),

  /** Query string from the request (e.g., '?page=2') */
  queryString: text('query_string'),

  /** HTTP Referer header */
  referrer: text('referrer'),

  /** User-Agent header */
  userAgent: text('user_agent'),

  /** Country code from Cloudflare cf.country (e.g., 'SG') */
  country: text('country'),

  /** City from Cloudflare cf.city (e.g., 'Singapore') */
  city: text('city'),

  /** Cloudflare datacenter code from cf.colo (e.g., 'SIN') */
  colo: text('colo'),

  /** Continent code from cf.continent (e.g., 'AS') */
  continent: text('continent'),

  /** HTTP protocol version from cf.httpProtocol (e.g., 'HTTP/2') */
  httpProtocol: text('http_protocol'),

  /** IANA timezone from cf.timezone (e.g., 'Asia/Singapore') */
  timezone: text('timezone'),

  /** Client IP address from CF-Connecting-IP header */
  ipAddress: text('ip_address'),

  /** Unix timestamp (seconds since epoch) */
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

/**
 * Type for inserting a new link click
 */
export type NewLinkClick = typeof linkClicks.$inferInsert;

/**
 * Type for selecting a link click
 */
export type LinkClick = typeof linkClicks.$inferSelect;

/**
 * Type for inserting a new page view
 */
export type NewPageView = typeof pageViews.$inferInsert;

/**
 * Type for selecting a page view
 */
export type PageView = typeof pageViews.$inferSelect;

/**
 * File downloads analytics table
 *
 * Records each R2 file download with metadata for analytics.
 * Tracks R2-specific fields like content type and file size.
 */
export const fileDownloads = sqliteTable('file_downloads', {
  /** Auto-increment primary key */
  id: integer('id').primaryKey({ autoIncrement: true }),

  /** Domain that received the request (e.g., 'example.com') */
  domain: text('domain').notNull(),

  /** Path that was requested (e.g., '/wedding/reception') */
  path: text('path').notNull(),

  /** R2 object key that was served */
  r2Key: text('r2_key').notNull(),

  /** Content-Type of the served file */
  contentType: text('content_type'),

  /** File size in bytes */
  fileSize: integer('file_size'),

  /** Query string from the request */
  queryString: text('query_string'),

  /** HTTP Referer header (where user came from) */
  referrer: text('referrer'),

  /** User-Agent header */
  userAgent: text('user_agent'),

  /** Country code from Cloudflare cf.country (e.g., 'SG') */
  country: text('country'),

  /** City from Cloudflare cf.city (e.g., 'Singapore') */
  city: text('city'),

  /** Cloudflare datacenter code from cf.colo (e.g., 'SIN') */
  colo: text('colo'),

  /** Continent code from cf.continent (e.g., 'AS') */
  continent: text('continent'),

  /** IANA timezone from cf.timezone (e.g., 'Asia/Singapore') */
  timezone: text('timezone'),

  /** HTTP protocol version from cf.httpProtocol (e.g., 'HTTP/2') */
  httpProtocol: text('http_protocol'),

  /** Client IP address from CF-Connecting-IP header */
  ipAddress: text('ip_address'),

  /** Cache status (HIT/MISS) from Cloudflare Cache API */
  cacheStatus: text('cache_status'),

  /** Unix timestamp (seconds since epoch) */
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

/**
 * Type for inserting a new file download
 */
export type NewFileDownload = typeof fileDownloads.$inferInsert;

/**
 * Type for selecting a file download
 */
export type FileDownload = typeof fileDownloads.$inferSelect;

/**
 * Proxy requests analytics table
 *
 * Records each proxy request with metadata for analytics.
 * Tracks proxy-specific fields like target URL and response status.
 */
export const proxyRequests = sqliteTable('proxy_requests', {
  /** Auto-increment primary key */
  id: integer('id').primaryKey({ autoIncrement: true }),

  /** Domain that received the request (e.g., 'example.com') */
  domain: text('domain').notNull(),

  /** Path that was requested (e.g., '/api/data') */
  path: text('path').notNull(),

  /** Target URL being proxied to */
  targetUrl: text('target_url').notNull(),

  /** HTTP response status code from proxy target */
  responseStatus: integer('response_status'),

  /** Content-Type of the proxied response */
  contentType: text('content_type'),

  /** Content-Length of the proxied response */
  contentLength: integer('content_length'),

  /** Query string from the request */
  queryString: text('query_string'),

  /** HTTP Referer header (where user came from) */
  referrer: text('referrer'),

  /** User-Agent header */
  userAgent: text('user_agent'),

  /** Country code from Cloudflare cf.country (e.g., 'SG') */
  country: text('country'),

  /** City from Cloudflare cf.city (e.g., 'Singapore') */
  city: text('city'),

  /** Cloudflare datacenter code from cf.colo (e.g., 'SIN') */
  colo: text('colo'),

  /** Continent code from cf.continent (e.g., 'AS') */
  continent: text('continent'),

  /** IANA timezone from cf.timezone (e.g., 'Asia/Singapore') */
  timezone: text('timezone'),

  /** HTTP protocol version from cf.httpProtocol (e.g., 'HTTP/2') */
  httpProtocol: text('http_protocol'),

  /** Client IP address from CF-Connecting-IP header */
  ipAddress: text('ip_address'),

  /** Unix timestamp (seconds since epoch) */
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

/**
 * Type for inserting a new proxy request
 */
export type NewProxyRequest = typeof proxyRequests.$inferInsert;

/**
 * Type for selecting a proxy request
 */
export type ProxyRequest = typeof proxyRequests.$inferSelect;

/**
 * Audit logs table
 *
 * Records admin actions for audit trail (create, update, delete, toggle, seed).
 * Captures actor identity via Tailscale headers when available.
 */
export const auditLogs = sqliteTable('audit_logs', {
  /** Auto-increment primary key */
  id: integer('id').primaryKey({ autoIncrement: true }),

  /** Domain affected by the action (e.g., 'example.com') */
  domain: text('domain').notNull(),

  /** Action type: create, update, delete, toggle, seed */
  action: text('action').notNull(),

  /** Actor identifier from Tailscale-User-Login header, or 'api-key' */
  actorLogin: text('actor_login'),

  /** Actor display name from Tailscale-User-Name header */
  actorName: text('actor_name'),

  /** Route path affected by the action (e.g., '/linkedin') */
  path: text('path'),

  /** JSON blob with action-specific details (before/after state, etc.) */
  details: text('details'),

  /** Client IP address from CF-Connecting-IP header */
  ipAddress: text('ip_address'),

  /** Unix timestamp (seconds since epoch) */
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

/**
 * Type for inserting a new audit log
 */
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * Type for selecting an audit log
 */
export type AuditLog = typeof auditLogs.$inferSelect;

/**
 * File comments table
 *
 * A free-text note per R2 file, stored in this D1 sidecar keyed by
 * (bucket, key). R2 custom metadata is copy-only and capped at 8 KB, so a
 * sidecar lets comment edits be a single UPSERT regardless of file size.
 */
export const fileComments = sqliteTable(
  'file_comments',
  {
    /** R2 bucket name (e.g., 'files') */
    bucket: text('bucket').notNull(),

    /** R2 object key the comment is attached to */
    key: text('key').notNull(),

    /** Free-text note (plain text, ≤1000 chars) */
    comment: text('comment').notNull(),

    /** Actor identifier from Tailscale-User-Login header, or null */
    updatedBy: text('updated_by'),

    /** Unix timestamp (seconds since epoch) */
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  },
  table => ({
    pk: primaryKey({ columns: [table.bucket, table.key] }),
  }),
);

/**
 * Type for inserting a new file comment
 */
export type NewFileComment = typeof fileComments.$inferInsert;

/**
 * Type for selecting a file comment
 */
export type FileComment = typeof fileComments.$inferSelect;

/**
 * Feedback work-queue table (v1.26.0)
 *
 * The AI-actionable feedback brain: a structured row per submission
 * (bug / feature / question / other). Triage fields are admin-set; screenshots
 * and the capture bundle live in the `bifrost-feedback` R2 bucket, referenced by
 * key. Migration: drizzle/0009_feedback.sql (apply per environment).
 */
export const feedback = sqliteTable('feedback', {
  /** UUIDv7 primary key (time-ordered, generated by the handler). */
  id: text('id').primaryKey(),

  /** Human-quotable short id, `F-<n>`, allocated atomically from `counters`. */
  shortId: text('short_id').notNull(),

  /** Submission category: bug | feature | question | other. */
  type: text('type').notNull(),

  /** Submitter-set technical impact: low | medium | high | critical (nullable). */
  severity: text('severity'),

  /** Triage-set priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: integer('priority').notNull().default(0),

  /** Triage lifecycle status. */
  status: text('status').notNull().default('new'),

  /** Short title. */
  title: text('title').notNull(),

  /** Full description. */
  description: text('description').notNull(),

  /** Optional structured fields. */
  steps: text('steps'),
  expected: text('expected'),
  actual: text('actual'),

  /** JSON blob of Tier-1 environment context (url, browser, os, viewport, …). */
  contextJson: text('context_json').notNull(),

  /** JSON array of R2 keys for stored screenshots. */
  screenshotKeys: text('screenshot_keys'),

  /** R2 key of the credential-redacted console/network/breadcrumb capture bundle. */
  captureKey: text('capture_key'),

  /** Admin-set triage metadata (all free text). */
  labels: text('labels'),
  area: text('area'),
  assignee: text('assignee'),
  triageNotes: text('triage_notes'),
  linkedPr: text('linked_pr'),
  externalRef: text('external_ref'),

  /** Optional free-text submitter metadata (NOT an identity claim — single-admin model). */
  submitterEmail: text('submitter_email'),
  submitterName: text('submitter_name'),

  /** ISO-8601 timestamps. */
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  resolvedAt: text('resolved_at'),
});

/**
 * Type for inserting a new feedback row
 */
export type NewFeedback = typeof feedback.$inferInsert;

/**
 * Type for selecting a feedback row
 */
export type FeedbackRow = typeof feedback.$inferSelect;

/**
 * Counters table (v1.26.0)
 *
 * Generic atomic sequence allocator. The `feedback` row holds the next `F-<n>`
 * value. D1 serialises writes, so `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * is atomic.
 */
export const counters = sqliteTable('counters', {
  /** Counter name (e.g., 'feedback'). */
  name: text('name').primaryKey(),

  /** Current value. */
  value: integer('value').notNull().default(0),
});

/**
 * Type for selecting a counter row
 */
export type Counter = typeof counters.$inferSelect;
