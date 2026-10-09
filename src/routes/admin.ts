import {
  canonicalJson,
  type InvalidRouteRow,
  RoutePathSchema,
  RoutesListQuerySchema,
  searchAndRankRoutes,
} from '@bifrost/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { checkBackupHealth } from '../backup/health';
import type { AuditAction } from '../db/analytics';
import { recordAuditLog } from '../db/analytics';
import { CHANGELOG_MARKDOWN } from '../generated/changelog-text';
import { normalizePath } from '../kv/lookup';
import {
  assertRouteKeyFits,
  createRoute,
  deleteRoute,
  findRoutesByR2Target,
  getRoute,
  getRouteAtExactKey,
  InvalidStoredRouteError,
  listAllDomainRoutes,
  listDomainRoutes,
  mergeRoutePatch,
  migrateRoute,
  presentRoute,
  ROUTE_CHANGED_DURING_EDIT_MESSAGE,
  RouteSourceChangedError,
  recoverInvalidRoute,
  seedRoutes,
  serializeStoredRoute,
  transferRoute,
  updateRoute,
} from '../kv/routes';
import {
  CreateRouteSchema,
  routeKey,
  SCHEMA_VERSION,
  TransferRouteRequestSchema,
  type UpdateRouteInput,
  UpdateRouteSchema,
} from '../kv/schema';
import { ADMIN_API_CORS_ORIGINS, cors } from '../middleware/cors';
import type { AppEnv, KVRouteConfig } from '../types';
import { isValidDomain, SUPPORTED_DOMAINS } from '../types';
import { isRecord } from '../utils/boundary';
import { purgeRouteUrl } from '../utils/cache';
import { CodedHTTPException } from '../utils/coded-http-exception';
import { validateApiKey } from '../utils/crypto';
import { errorName } from '../utils/error-name';
import { adminKeyFromAuthorization } from '../utils/internal-headers';
import { requestBodyGuard } from '../utils/json-body';
import { ownHostResolver } from '../utils/og-own-host';
import { describeOpenGraphFailure, parseOpenGraph } from '../utils/og-parser';
import { findCredentialParams } from '../utils/unified-traffic';
import { analyticsRoutes } from './analytics';
import { feedbackRoutes } from './feedback';
import { qrRoutes } from './qr';
import {
  getActorInfo,
  getDomainFromRequest,
  getDomainOrDefaultFromRequest,
  getRequiredDomainFromRequest,
} from './request-context';
import { storageRoutes } from './storage';

/**
 * Zone-purge one route's own URL after a mutation — r2 routes only.
 *
 * Only the r2 serve path writes to `caches.default`, so repointing, disabling,
 * deleting, or moving an r2 route left the OLD body being served from every
 * edge PoP until `max-age` expired. Redirect and proxy routes are never edge-
 * cached by Bifrost, so this is a deliberate no-op for them.
 *
 * Best-effort and non-blocking, mirroring the audit-log pattern: `waitUntil`
 * inside try/catch because `c.executionCtx` is unavailable under test. The
 * purge promise carries its own rejection handler — an unhandled rejection
 * inside `waitUntil` can abort the whole invocation, and a transient Cloudflare
 * API failure must not take the mutation's response down with it.
 */
function purgeRouteUrlIfR2(
  c: Context<AppEnv>,
  route: { type?: string } | null | undefined,
  domain: string,
  path: string,
): void {
  if (route?.type === 'r2') purgeRoutePublicUrl(c, domain, path);
}

/**
 * Zone-purge a route's public URL whatever its type (best-effort, as
 * {@link purgeRouteUrlIfR2}): for a deleted record that could not be read,
 * whose type is unknown (v1.38.0).
 */
function purgeRoutePublicUrl(c: Context<AppEnv>, domain: string, path: string): void {
  // Purge the CANONICAL path — callers may pass the raw request value
  // ('/Report/'), while the cached URL and the stored route use the normalized
  // form ('/report'). Residual: mixed-case REQUEST-URL variants are separate
  // cache keys and expire via TTL only.
  purgeStoredPathUrl(c, domain, normalizePath(path));
}

/**
 * Zone-purge the public URL of a path EXACTLY as stored (v1.38.0): each
 * segment is percent-encoded by `purgeRouteUrl` and nothing is normalised
 * again, so the exact-key recovery of `/p?x` purges `/p%3Fx`, never `/p`
 * (`normalizePath()` is not idempotent). Best-effort and non-blocking, as
 * {@link purgeRouteUrlIfR2}.
 */
function purgeStoredPathUrl(c: Context<AppEnv>, domain: string, storedPath: string): void {
  // Cloudflare's purge-by-URL does not expand wildcards, and purge-by-prefix is
  // an Enterprise feature. Issuing the purge anyway would delete nothing while
  // reporting success — worse than an honest skip, because an operator would
  // believe the cache was cleared.
  if (storedPath.includes('*')) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'purge not possible for wildcard route — cached sub-paths expire via TTL',
        domain,
        path: storedPath,
      }),
    );
    return;
  }

  try {
    c.executionCtx.waitUntil(
      purgeRouteUrl(domain, storedPath, c.env.CLOUDFLARE_API_TOKEN).catch(error => {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'cache purge failed',
            domain,
            path: storedPath,
            errorName: errorName(error),
          }),
        );
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip cache purge
  }
}

/**
 * Refuse a route write whose TARGET carries a credential-named query parameter,
 * unless the operator acknowledged it.
 *
 * A configured target is not request data — it is stored in KV and copied into
 * `link_clicks.target_url` and `proxy_requests.target_url`. (This Worker's
 * `Route matched` log line carries only the host, the route path and the route
 * type, so the target does not reach the logs here.) The recorder redaction
 * stops the analytics tables holding a credential that arrived in the REQUEST;
 * this stops one being planted in the route itself. A short link is a public
 * handle: anyone who opens it exercises the credential.
 *
 * The predicate is the NAME-ONLY predicate, deliberately NOT the narrowed
 * legacy rule, so `?code=SUMMER25` IS flagged as `code`. A human can look at it
 * and acknowledge; a silent shape heuristic cannot.
 *
 * Scope:
 *  - Only a write that leaves the route ENABLED is guarded. Disabling, or
 *    creating something already disabled, serves nothing — and refusing a
 *    DISABLE would block the very action that reduces exposure. Enabling is
 *    guarded, so a credential-bearing route can never be live unacknowledged.
 *  - `r2` targets are object keys, not URLs, and have no query component.
 *
 * Returns the refusal body, or `null` when the write may proceed. The caller
 * keeps the parameter names for the audit row when it proceeds WITH the
 * acknowledgement; values are never read, returned, or logged.
 */
interface CredentialTargetRefusal {
  success: false;
  error: 'ROUTE_TARGET_CREDENTIAL';
  message: string;
  details: { parameters: string[] };
}

/**
 * ⚠️ The WHATWG URL parser STRIPS tab, LF and CR from anywhere in a URL, so a
 * target whose query reads `to<TAB>ken=LIVE` scans clean and then SERVES
 * `?token=LIVE`. The schema now refuses control characters outright, but the
 * guard must not depend on that alone — a stored route predating this release,
 * or any future caller bypassing the schema, would slip through. So the scan
 * runs on the target with those three characters removed, and for a URL target
 * it ALSO scans what the parser actually produced, taking the union.
 */
const URL_STRIPPED_CHARACTERS = /[\t\n\r]/g;

export function credentialTargetParameters(route: {
  type?: string | undefined;
  target?: string | undefined;
  enabled?: boolean | undefined;
}): string[] {
  if (route.enabled === false) return [];
  if (route.type === 'r2') return [];
  if (!route.target) return [];

  const names = new Set(findCredentialParams(route.target.replace(URL_STRIPPED_CHARACTERS, '')));

  // What the redirect/proxy handler will actually emit, as the parser sees it.
  try {
    const parsed = new URL(route.target);
    for (const name of findCredentialParams(`${parsed.search}${parsed.hash}`)) names.add(name);
  } catch {
    // Not an absolute URL (a relative target, or an R2-shaped one on a
    // mistyped type) — the raw scan above is the whole answer.
  }

  return [...names];
}

function credentialTargetRefusal(parameters: string[], subject: string): CredentialTargetRefusal {
  return {
    success: false,
    error: 'ROUTE_TARGET_CREDENTIAL',
    message: `${subject} carries credential-named parameter${parameters.length === 1 ? '' : 's'} (${parameters.join(', ')}); anyone with the short link can use ${parameters.length === 1 ? 'it' : 'them'}. Re-send with acknowledgeCredentialTarget: true to store it anyway.`,
    details: { parameters },
  };
}

/**
 * The raw request body's acknowledgement flag. Read from the RAW body on
 * purpose: the stored-shape schemas do not carry it, so Zod strips it on parse
 * and it can never reach KV or a route response.
 */
function readCredentialAcknowledgement(body: unknown): boolean {
  return isRecord(body) && body['acknowledgeCredentialTarget'] === true;
}

/**
 * Admin API routes for route management
 *
 * All endpoints require ADMIN_API_KEY header
 * Middleware order: Domain Check → CORS (for preflight) → Auth
 * Note: Domain check comes first to hide admin API on other domains
 * Note: Rate limiting handled by Cloudflare WAF, not in Worker code
 */
export const adminRoutes = new Hono<AppEnv>();

/**
 * Domain restriction middleware (FIRST - hides admin API on non-primary domains)
 * Returns 404 for requests not from ADMIN_API_DOMAIN
 * This reduces attack surface by exposing admin API on only one domain
 */
adminRoutes.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const adminDomain = c.env.ADMIN_API_DOMAIN;

  // If ADMIN_API_DOMAIN is not set, allow all domains (for development)
  if (adminDomain && url.hostname !== adminDomain) {
    // Return 404 to hide existence of admin API on other domains
    return c.json(
      {
        error: 'Not Found',
        path: c.req.path,
        message: 'No route configured for this path.',
      },
      404,
    );
  }
  await next();
  return undefined;
});

/**
 * CORS middleware for cross-origin requests (SECOND - handles preflight without auth)
 * No origin is allowed (v1.39.0): the dashboard reaches the API through its
 * own server, never from the browser (ADMIN_API_CORS_ORIGINS)
 */
adminRoutes.use('*', cors({ origins: [...ADMIN_API_CORS_ORIGINS] }));

/**
 * API key authentication middleware (SECOND - after CORS handles preflight)
 * Uses timing-safe comparison to prevent timing attacks. A CORS preflight
 * never gets here: the CORS middleware answers it, the one bypass (v1.40.0;
 * this middleware used to skip every OPTIONS request as well).
 */
adminRoutes.use('*', async (c, next) => {
  const apiKey =
    c.req.header('X-Admin-Key') || adminKeyFromAuthorization(c.req.header('Authorization'));
  const expectedKey = c.env.ADMIN_API_KEY;

  if (!expectedKey) {
    throw new HTTPException(500, { message: 'Admin API key not configured' });
  }

  // Use timing-safe comparison to prevent timing attacks
  if (!validateApiKey(apiKey, expectedKey)) {
    throw new HTTPException(401, { message: 'Invalid or missing API key' });
  }

  await next();
});

/**
 * The body guard (THIRD - after auth, before every route): JSON or no body,
 * multipart only on the upload endpoints (v1.39.0; utils/json-body.ts)
 */
adminRoutes.use('*', requestBodyGuard());

/**
 * GET /api/routes - List all routes OR get single route
 *
 * List mode (no ?path): Returns all routes for domain (or all domains)
 * Single mode (?path=/linkedin): Returns specific route
 *
 * Supports: X-Domain header or ?domain= query param (both sent must agree, or
 * 400), and ?path= query param
 */
adminRoutes.get('/routes', async c => {
  const pathQuery = c.req.query('path');

  // Single route lookup mode (a read: keeps the ADMIN_API_DOMAIN default)
  if (pathQuery) {
    const domainResult = getDomainOrDefaultFromRequest(c);

    if (!domainResult.valid) {
      return c.json(
        {
          success: false,
          error: domainResult.error,
          supportedDomains: SUPPORTED_DOMAINS,
        },
        400,
      );
    }

    const domain = domainResult.domain;
    // A stored record that cannot be read is not answered as absent
    // (v1.38.0): 409 ROUTE_RECORD_INVALID, as every write but DELETE answers
    const route = presentRoute(await getRoute(c.env.ROUTES, domain, pathQuery));

    if (!route) {
      throw new HTTPException(404, {
        message: `Route not found: ${pathQuery}`,
      });
    }

    return c.json({
      success: true,
      data: route,
    });
  }

  // List all routes mode
  const domainResult = getDomainFromRequest(c);

  // Return 400 for invalid domain values
  if (!domainResult.valid) {
    return c.json(
      {
        success: false,
        error: domainResult.error,
        supportedDomains: SUPPORTED_DOMAINS,
      },
      400,
    );
  }

  const domain = domainResult.domain;

  // Parse search/pagination query params. An invalid query is refused (400),
  // never answered with an unfiltered list (v1.38.0): an over-long search
  // (SEARCH_PARAM_MAX_LENGTH, in the schema), a limit or offset that is not a
  // whole number in range, an unknown type or enabled value
  const queryParams = RoutesListQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    search: c.req.query('search'),
    type: c.req.query('type'),
    enabled: c.req.query('enabled'),
  });
  if (!queryParams.success) {
    const issue = queryParams.error.issues[0];
    return c.json(
      {
        success: false,
        error: `Invalid query: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed'}`,
      },
      400,
    );
  }

  const { limit, offset, search, type: typeFilter, enabled: enabledFilter } = queryParams.data;

  // Get all routes for domain(s). In a one-domain list the domain is the
  // same for every route, so the rows carry no domain until the page is
  // built: a search must not match it (v1.38.0). The listing keeps the
  // records that cannot be read apart from the readable ones, by the read's
  // own status (never by a field of a record, which a readable record may
  // hold): each is listed as a minimal row (`{ domain, path, invalid: true }`,
  // v1.38.0), after the readable routes, so it can be found and deleted.
  const listing = domain
    ? await listDomainRoutes(c.env.ROUTES, domain)
    : await listAllDomainRoutes(c.env.ROUTES);

  // Newest first (v1.38.0), so pages follow the order the dashboard shows. A
  // search keeps only its matches, ordered by relevance (exact path, path
  // prefix, other path matches, other fields; the domain as typed only, and
  // only in the all-domains list), newest first on ties: the shared matcher
  // (`@bifrost/shared` search.ts) the dashboard, Cmd+K and MCP `list_routes`
  // all read through this list.
  const readable: Array<KVRouteConfig & { domain?: string }> = listing.routes.toSorted(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  );
  const matched = search ? searchAndRankRoutes(readable, search) : readable;
  const filtered = matched.filter(
    route =>
      (!typeFilter || route.type === typeFilter) &&
      (enabledFilter === undefined || (route.enabled !== false) === (enabledFilter === 'true')),
  );

  // An unreadable record matches a search by its path (and its domain in the
  // all-domains list) only; its type and state are unknown, so a type or
  // enabled filter shows none
  const unreadable =
    typeFilter || enabledFilter !== undefined
      ? []
      : listing.invalid.map(row => ({
          row,
          // What a search may match: the path, and the domain in the
          // all-domains list only
          path: row.path,
          ...(domain ? {} : { domain: row.domain }),
        }));
  const unreadableMatched = search ? searchAndRankRoutes(unreadable, search) : unreadable;

  const rows: Array<KVRouteConfig | InvalidRouteRow> = [
    ...filtered.map(route => (domain ? { ...route, domain } : route)),
    ...unreadableMatched.map(({ row }) => row),
  ];
  const total = rows.length;

  // Apply pagination (only if limit is provided)
  const page =
    limit !== undefined
      ? rows.slice(offset, offset + limit)
      : offset > 0
        ? rows.slice(offset)
        : rows;

  return c.json({
    success: true,
    data: {
      routes: page,
      meta: {
        version: SCHEMA_VERSION,
        updatedAt: Date.now(),
        count: page.length,
        total,
        offset,
        hasMore: offset + page.length < total,
      },
      targetDomain: domain || 'all',
      supportedDomains: SUPPORTED_DOMAINS,
    },
  });
});

/**
 * POST /api/routes - Create a new route
 */
adminRoutes.post('/routes', async c => {
  const domainResult = getRequiredDomainFromRequest(c);

  // Return 400 for invalid domain values
  if (!domainResult.valid) {
    return c.json(
      {
        success: false,
        error: domainResult.error,
        supportedDomains: SUPPORTED_DOMAINS,
      },
      400,
    );
  }

  const domain = domainResult.domain;
  const body: unknown = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });

  // Validate input
  const result = CreateRouteSchema.safeParse(body);
  if (!result.success) {
    return c.json(
      {
        success: false,
        error: 'Validation failed',
        details: result.error.issues,
      },
      400,
    );
  }

  // Credential-shaped target guard. After validation and before the existence
  // check: a refusal must not disclose whether the path is already taken.
  const credentialParams = credentialTargetParameters(result.data);
  if (credentialParams.length > 0 && !readCredentialAcknowledgement(body)) {
    return c.json(credentialTargetRefusal(credentialParams, 'This route target'), 400);
  }

  // Check if route already exists. A stored record that cannot be read is
  // present too: never overwritten, 409 ROUTE_RECORD_INVALID (v1.38.0)
  const existing = await getRoute(c.env.ROUTES, domain, result.data.path);
  if (existing.status === 'invalid') throw new InvalidStoredRouteError();
  if (existing.status === 'ok') {
    return c.json(
      {
        success: false,
        error: `Route already exists: ${result.data.path}`,
      },
      409,
    );
  }

  const route = await createRoute(c.env.ROUTES, domain, result.data);

  // Record audit log (non-blocking) - only if executionCtx is available
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action: 'create',
        actorLogin: actor.login,
        actorName: actor.name,
        path: result.data.path,
        details: JSON.stringify({
          route,
          // Names only, never values — the operator overrode the guard and the
          // audit row must say so.
          ...(credentialParams.length > 0
            ? { credentialTargetAcknowledged: credentialParams }
            : {}),
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

  // A create can land on a URL that previously 404'd or served a deleted route.
  purgeRouteUrlIfR2(c, route, domain, result.data.path);

  return c.json(
    {
      success: true,
      data: route,
    },
    201,
  );
});

/**
 * PUT /api/routes - Update a route
 *
 * Requires ?path= query parameter to specify which route to update.
 * This avoids URL encoding issues with paths containing "/" characters.
 */
adminRoutes.put('/routes', async c => {
  const path = c.req.query('path');

  if (!path) {
    return c.json(
      {
        success: false,
        error: 'Path query parameter is required',
      },
      400,
    );
  }

  const domainResult = getRequiredDomainFromRequest(c);

  // Return 400 for invalid domain values
  if (!domainResult.valid) {
    return c.json(
      {
        success: false,
        error: domainResult.error,
        supportedDomains: SUPPORTED_DOMAINS,
      },
      400,
    );
  }

  const domain = domainResult.domain;

  // A missing route is a 404 before anything about the patch is judged
  // (v1.37.2), so the answer does not depend on what was sent. A stored record
  // that cannot be read is never merged with a patch (v1.38.0): 409, and the
  // operator deletes it and creates it again
  const beforeState = await getRoute(c.env.ROUTES, domain, path);
  if (beforeState.status === 'missing') {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }
  if (beforeState.status === 'invalid') throw new InvalidStoredRouteError();
  const beforeRoute = beforeState.value;

  const body: unknown = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });

  // Validate input. A body that is not a JSON object goes to the schema as it
  // is, so it is refused as a type error — spread over `path` it would read as
  // an empty patch (and `null` then failed AFTER the write, on the audit step).
  const result = UpdateRouteSchema.safeParse(isRecord(body) ? { ...body, path } : body);
  if (!result.success) {
    return c.json(
      {
        success: false,
        error: 'Validation failed',
        details: result.error.issues,
      },
      400,
    );
  }
  // The schema accepted an object, so its fields can be read for the audit row.
  const fields: Record<string, unknown> = isRecord(body) ? body : {};

  // Optional client precondition (v1.40.0): the `updatedAt` of the route as
  // the client loaded it. A route changed since (or with no such stamp) is
  // refused with the same 409 as a change during the edit, so an edit made
  // before the dialog was opened is caught too.
  const expected = readExpectedUpdatedAt(fields);
  if (!expected.valid) return c.json(EXPECTED_UPDATED_AT_REFUSAL, 400);
  if (expected.value !== undefined && beforeRoute.updatedAt !== expected.value) {
    throw new RouteSourceChangedError(ROUTE_CHANGED_DURING_EDIT_MESSAGE);
  }

  // Credential-shaped target guard — on the EFFECTIVE post-update route, so a
  // patch that leaves a credential target in place, or a re-enable of a stored
  // one, is guarded exactly like a fresh target.
  const effectiveRoute = { ...beforeRoute, ...result.data };
  const credentialParams = credentialTargetParameters(effectiveRoute);
  if (credentialParams.length > 0 && !readCredentialAcknowledgement(body)) {
    return c.json(
      credentialTargetRefusal(
        credentialParams,
        result.data.target === undefined ? "This route's stored target" : 'This route target',
      ),
      400,
    );
  }

  // The record checked above is the one written (v1.39.0): a route that has
  // changed since that read is refused with 409 ROUTE_SOURCE_CHANGED, never
  // merged, and one deleted since is 404, never recreated (best effort; see
  // updateRoute)
  const route = await updateRoute(c.env.ROUTES, domain, path, result.data, beforeRoute);

  if (!route) {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }

  // Determine if this is a toggle action or general update. The
  // acknowledgement is a request-only flag, not an edited field, so it must not
  // turn a toggle into an 'update' in the audit trail.
  const editedKeys = Object.keys(fields).filter(
    key => key !== 'acknowledgeCredentialTarget' && key !== 'expectedUpdatedAt',
  );
  const isToggle = editedKeys.length === 1 && editedKeys[0] === 'enabled';
  const action: AuditAction = isToggle ? 'toggle' : 'update';

  // Record audit log (non-blocking) - only if executionCtx is available
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action,
        actorLogin: actor.login,
        actorName: actor.name,
        path,
        details: JSON.stringify({
          // A toggle keeps its short row with the route key and `enabled`
          // before and after (v1.38.0), so an edit that only switched the
          // route keeps a before/after trail like any other update
          ...(isToggle
            ? {
                enabled: fields['enabled'],
                key: `${domain}:${route.path}`,
                before: { enabled: beforeRoute.enabled !== false },
                after: { enabled: route.enabled !== false },
              }
            : { before: beforeRoute, after: route }),
          ...(credentialParams.length > 0
            ? { credentialTargetAcknowledged: credentialParams }
            : {}),
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

  // Covers toggle and retarget. The BEFORE type matters too: repointing an r2
  // route at a redirect leaves the cached file body serving from the edge under
  // the same URL. Both sides share one URL, so one purge covers either case.
  purgeRouteUrlIfR2(c, route.type === 'r2' ? route : beforeRoute, domain, path);

  return c.json({
    success: true,
    data: route,
  });
});

/**
 * The optional client precondition of a route edit or move (v1.40.0),
 * `expectedUpdatedAt`: the route's `updatedAt` as the client loaded it. Read
 * off the raw body (a request flag, never a route field); absent is no
 * precondition, anything but a non-negative integer is refused.
 */
function readExpectedUpdatedAt(
  body: Record<string, unknown>,
): { valid: true; value?: number } | { valid: false } {
  if (!Object.hasOwn(body, 'expectedUpdatedAt')) return { valid: true };
  const value = body['expectedUpdatedAt'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { valid: true, value }
    : { valid: false };
}

/** The 400 answer to an `expectedUpdatedAt` that is not a non-negative integer. */
const EXPECTED_UPDATED_AT_REFUSAL = {
  success: false,
  error: 'Validation failed',
  details: [
    {
      path: ['expectedUpdatedAt'],
      message: 'expectedUpdatedAt must be the route updatedAt (a non-negative integer)',
    },
  ],
} as const;

/**
 * DELETE /api/routes - Delete a route
 *
 * Requires ?path= query parameter to specify which route to delete.
 * This avoids URL encoding issues with paths containing "/" characters (e.g., root path "/").
 */
adminRoutes.delete('/routes', async c => {
  const path = c.req.query('path');

  if (!path) {
    return c.json(
      {
        success: false,
        error: 'Path query parameter is required',
      },
      400,
    );
  }

  const domainResult = getRequiredDomainFromRequest(c);

  // Return 400 for invalid domain values
  if (!domainResult.valid) {
    return c.json(
      {
        success: false,
        error: domainResult.error,
        supportedDomains: SUPPORTED_DOMAINS,
      },
      400,
    );
  }

  const domain = domainResult.domain;

  // The recovery of a record that cannot be read (v1.38.0): the EXACT key
  if (c.req.query('recover') !== undefined) {
    return recoverInvalidRouteRecord(c, domain, path);
  }

  // The ordinary delete never reaches a route other than the one it names
  // (v1.41.2). `deleteRoute` normalises, so a DELETE quoting a LEGACY listed
  // value would resolve to another key and delete a DIFFERENT, live record:
  // - a path that does not round-trip (`/p?x` → `/p`) is REFUSED (400), as
  //   create, update, migrate and transfer refuse it;
  // - a path that is not in normalised form (`/Promo`, `/promo/`) is refused
  //   (409 ROUTE_KEY_NOT_NORMALIZED) when a record is stored at that EXACT key,
  //   readable or not, since that record is what the caller is looking at.
  //   With nothing there it keeps normalising (`/Promo/` deletes `/promo`).
  //   An already-normalised path costs no extra read.
  // Such a record is removed by its exact key only when it cannot be read
  // (`recover=invalid`); a readable one cannot be deleted at its own key
  // through the API (`normalize-case` re-keys a capitalised one whose
  // lower-case path is free, after which the ordinary delete reaches it).
  const deletePath = RoutePathSchema.safeParse(path);
  if (!deletePath.success) {
    return c.json({ success: false, error: deletePath.error.issues[0].message }, 400);
  }
  const normalizedDeletePath = normalizePath(path);
  if (normalizedDeletePath !== path) {
    const atExactKey = await getRouteAtExactKey(c.env.ROUTES, domain, path);
    if (atExactKey.status !== 'missing') {
      throw new CodedHTTPException(
        409,
        'ROUTE_KEY_NOT_NORMALIZED',
        routeKeyNotNormalizedMessage(normalizedDeletePath),
      );
    }
  }

  // One read: the state the delete found, for the audit row and the purge.
  // A record that cannot be read is deleted too, which is how it is recovered
  // (v1.38.0)
  const deleted = await deleteRoute(c.env.ROUTES, domain, path);

  if (deleted.status === 'missing') {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }
  const key = `${domain}:${normalizePath(path)}`;

  // Record audit log (non-blocking) - only if executionCtx is available
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action: 'delete',
        actorLogin: actor.login,
        actorName: actor.name,
        path,
        // An unreadable record's row names its key and state, never the value
        details: JSON.stringify(
          deleted.status === 'ok' ? { route: deleted.value } : { key, state: 'invalid' },
        ),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

  // The route is gone from KV but the edge still serves the file it pointed
  // at. An unreadable record's type is unknown, so its public URL (from the
  // key: domain and normalised path) is purged whatever it served; purging a
  // URL that was not cached is harmless.
  if (deleted.status === 'ok') purgeRouteUrlIfR2(c, deleted.value, domain, path);
  else purgeRoutePublicUrl(c, domain, path);

  return c.json({
    success: true,
    message: `Route deleted: ${path}`,
  });
});

/**
 * The refusal of an ordinary delete whose path names a stored record at a key
 * that is not in normalised form (v1.41.2): the delete would normalise and
 * remove the route at `normalizedPath` instead.
 */
export function routeKeyNotNormalizedMessage(normalizedPath: string): string {
  return (
    `A route is stored at this exact path, which is not in normalised form; deleting it here ` +
    `would delete ${normalizedPath} instead, so nothing was deleted. If it cannot be read, ` +
    `delete it with recover=invalid; a readable one cannot be deleted at its own key through the API.`
  );
}

/** The fixed refusal of a recovery aimed at a readable route. */
export const ROUTE_RECOVERY_READABLE =
  'The route at this key can be read: delete it with the ordinary delete, not the recovery.';

/**
 * `DELETE /api/routes?path=&domain=&recover=invalid` — delete the record at
 * EXACTLY `{domain}:{path}`, only when it cannot be read (v1.38.0). The path
 * is the one the listing's unreadable row shows, taken as the stored key: it
 * is neither normalised nor checked by the route-path schema (a legacy key may
 * hold `?` or capitals), so the call can never reach another route. 404 when
 * the key holds nothing, 409 `ROUTE_RECORD_READABLE` when it holds a readable
 * route (the ordinary delete is for that); otherwise deleted, its public URL
 * purged exactly as stored (each segment percent-encoded, nothing normalised
 * again; the record's type is unknown, and purging an uncached URL is
 * harmless) and audited with the key and `state: "invalid"`.
 */
async function recoverInvalidRouteRecord(
  c: Context<AppEnv>,
  domain: string,
  path: string,
): Promise<Response> {
  if (c.req.query('recover') !== 'invalid') {
    return c.json({ success: false, error: 'recover must be "invalid"' }, 400);
  }
  if (!path.startsWith('/')) {
    return c.json({ success: false, error: 'Path must start with /' }, 400);
  }
  const outcome = await recoverInvalidRoute(c.env.ROUTES, domain, path);
  if (outcome === 'missing') {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }
  if (outcome === 'readable') {
    throw new CodedHTTPException(409, 'ROUTE_RECORD_READABLE', ROUTE_RECOVERY_READABLE);
  }
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action: 'delete',
        actorLogin: actor.login,
        actorName: actor.name,
        path,
        // The key and state only, never the unreadable value
        details: JSON.stringify({ key: routeKey(domain, path), state: 'invalid', recovery: true }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }
  purgeStoredPathUrl(c, domain, path);
  return c.json({ success: true, message: `Unreadable route record deleted: ${path}` });
}

/**
 * POST /api/routes/seed - Seed routes from static config
 */
adminRoutes.post('/routes/seed', async c => {
  const domainResult = getRequiredDomainFromRequest(c);

  // Return 400 for invalid domain values
  if (!domainResult.valid) {
    return c.json(
      {
        success: false,
        error: domainResult.error,
        supportedDomains: SUPPORTED_DOMAINS,
      },
      400,
    );
  }

  const domain = domainResult.domain;
  // Read as unknown; anything but an object carrying a `routes` array, `null`
  // included, is refused below.
  const body: unknown = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });

  if (!isRecord(body) || !Array.isArray(body['routes'])) {
    return c.json(
      {
        success: false,
        error: 'Request body must contain a "routes" array',
      },
      400,
    );
  }

  // Validate all routes
  const validRoutes = [];
  const errors = [];
  // Credential-target names and the paths carrying them, unioned across the batch.
  const seedCredentialParams = new Set<string>();
  const seedCredentialPaths = new Set<string>();
  const seedCredentialParamsByPath = new Map<string, string[]>();

  const submitted: unknown[] = body['routes'];
  for (const route of submitted) {
    const result = CreateRouteSchema.safeParse(route);
    if (result.success) {
      // Seed takes full route bodies, so it can plant exactly what create
      // refuses; one acknowledgement covers the whole batch, and the refusal
      // names the offending paths so an operator can find them in a 50-route
      // payload.
      const routeCredentialParams = credentialTargetParameters(result.data);
      if (routeCredentialParams.length > 0) {
        for (const name of routeCredentialParams) seedCredentialParams.add(name);
        seedCredentialPaths.add(result.data.path);
        // Keyed by path so the audit row can name only what was CREATED — seed
        // skips a path that already exists, and an override recorded against a
        // route this call did not write would be a false audit entry.
        seedCredentialParamsByPath.set(result.data.path, routeCredentialParams);
      }
      validRoutes.push(result.data);
    } else {
      // A seed entry may be `null` or a primitive, which has no path to report.
      errors.push({
        path: isRecord(route) ? route['path'] : undefined,
        issues: result.error.issues,
      });
    }
  }

  if (errors.length > 0) {
    return c.json(
      {
        success: false,
        error: 'Some routes failed validation',
        details: errors,
      },
      400,
    );
  }

  // Credential-shaped target guard — AFTER validation, so a malformed batch
  // reports what is malformed instead of sending the operator round the
  // acknowledgement loop first.
  if (seedCredentialParams.size > 0 && !readCredentialAcknowledgement(body)) {
    const parameters = [...seedCredentialParams];
    return c.json(
      {
        ...credentialTargetRefusal(parameters, 'A seeded route target'),
        details: { parameters, paths: [...seedCredentialPaths] },
      },
      400,
    );
  }

  const result = await seedRoutes(c.env.ROUTES, domain, validRoutes);

  // Only the routes this call actually WROTE may be recorded as acknowledged:
  // seed skips a path that already exists, and naming it here would claim an
  // override against a record the operator never changed.
  const acknowledgedNames = new Set<string>();
  for (const createdPath of result.createdPaths) {
    for (const name of seedCredentialParamsByPath.get(createdPath) ?? []) {
      acknowledgedNames.add(name);
    }
  }

  // Record audit log (non-blocking) - only if executionCtx is available
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action: 'seed',
        actorLogin: actor.login,
        actorName: actor.name,
        path: null,
        details: JSON.stringify({
          count: validRoutes.length,
          paths: validRoutes.map(r => r.path),
          ...(acknowledgedNames.size > 0
            ? { credentialTargetAcknowledged: [...acknowledgedNames] }
            : {}),
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

  return c.json({
    success: true,
    data: result,
  });
});

/**
 * POST /api/routes/migrate - Migrate a route to a new path
 */
adminRoutes.post('/routes/migrate', async c => {
  const oldPath = c.req.query('oldPath');
  const newPath = c.req.query('newPath');

  if (!oldPath) {
    return c.json({ success: false, error: 'oldPath query parameter is required' }, 400);
  }
  if (!newPath) {
    return c.json({ success: false, error: 'newPath query parameter is required' }, 400);
  }
  if (!oldPath.startsWith('/')) {
    return c.json({ success: false, error: 'oldPath must start with /' }, 400);
  }
  if (!newPath.startsWith('/')) {
    return c.json({ success: false, error: 'newPath must start with /' }, 400);
  }
  // Migrate validated the leading slash and nothing else, so a `newPath`
  // carrying an encoded `?` or `#` was stored under a key that its own listed
  // value can never resolve again. Same schema as every other path.
  for (const candidate of [oldPath, newPath]) {
    const parsed = RoutePathSchema.safeParse(candidate);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
    }
  }

  const domainResult = getRequiredDomainFromRequest(c);
  if (!domainResult.valid) {
    return c.json(
      {
        success: false,
        error: domainResult.error,
        supportedDomains: SUPPORTED_DOMAINS,
      },
      400,
    );
  }

  const domain = domainResult.domain;

  // The same path once normalised: refused before anything is read
  if (normalizePath(oldPath) === normalizePath(newPath)) {
    return c.json({ success: false, error: 'Old path and new path cannot be the same' }, 400);
  }

  // An optional patch (v1.38.0): the other fields of an edit that also
  // changes the path, applied to the moved record in the SAME single write at
  // the new key. KV takes one write per key per second, so a move followed by
  // an update of the new key could lose the update. The patch is validated as
  // an update body; the credential guard and the size checks run on the
  // merged record, and a refusal moves nothing. No body, an empty one, `{}`,
  // or one with no field besides `path` (every other key stripped by the
  // schema) moves the record unedited, as before: no credential guard, no
  // patch in the audit row.
  const rawBody = await c.req.text();
  let patch: Omit<UpdateRouteInput, 'path'> | undefined;
  let acknowledged = false;
  // The client precondition (v1.40.0), as on PUT: checked against the source
  let expectedUpdatedAt: number | undefined;
  if (rawBody.trim() !== '') {
    // A body is optional here; one that is sent says it is JSON (the body
    // guard refused anything else before this handler ran)
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    }
    // Parsed as an update body, whose `path` is the route's own: here the new
    // path, which the move sets itself
    const result = UpdateRouteSchema.safeParse(isRecord(body) ? { ...body, path: newPath } : body);
    if (!result.success) {
      return c.json(
        { success: false, error: 'Validation failed', details: result.error.issues },
        400,
      );
    }
    const { path: _path, ...fields } = result.data;
    if (Object.values(fields).some(value => value !== undefined)) patch = fields;
    acknowledged = readCredentialAcknowledgement(body);
    const expected = readExpectedUpdatedAt(isRecord(body) ? body : {});
    if (!expected.valid) return c.json(EXPECTED_UPDATED_AT_REFUSAL, 400);
    expectedUpdatedAt = expected.value;
  }

  // The source, read ONCE here (v1.38.0): the credential guard, the merge and
  // the audit row use this record, and migrateRoute only confirms it is still
  // the same before writing. A source that has gone is 404, one replaced in
  // between 409 ROUTE_SOURCE_CHANGED, an unreadable one 409
  // ROUTE_RECORD_INVALID; nothing is re-read and moved in its place.
  const source = presentRoute(await getRoute(c.env.ROUTES, domain, oldPath));
  if (!source) {
    throw new HTTPException(404, { message: `Route not found: ${oldPath}` });
  }
  // Changed since the client loaded it: nothing moves (v1.40.0)
  if (expectedUpdatedAt !== undefined && source.updatedAt !== expectedUpdatedAt) {
    throw new RouteSourceChangedError();
  }

  let credentialParams: string[] = [];
  if (patch) {
    // As an update guards it: the EFFECTIVE moved record, before anything moves
    credentialParams = credentialTargetParameters(
      mergeRoutePatch(source, patch, normalizePath(newPath)),
    );
    if (credentialParams.length > 0 && !acknowledged) {
      return c.json(
        credentialTargetRefusal(
          credentialParams,
          patch.target === undefined ? "This route's stored target" : 'This route target',
        ),
        400,
      );
    }
  }

  try {
    const route = await migrateRoute(c.env.ROUTES, domain, oldPath, newPath, { source, patch });

    if (!route) {
      throw new HTTPException(404, { message: `Route not found: ${oldPath}` });
    }

    // Audit log
    try {
      const actor = getActorInfo(c);
      c.executionCtx.waitUntil(
        recordAuditLog(c.env.DB, {
          domain,
          action: 'migrate',
          actorLogin: actor.login,
          actorName: actor.name,
          path: newPath,
          details: JSON.stringify({
            oldPath,
            newPath,
            route,
            // A move that also edited the route keeps the parsed edit and
            // the record before it (v1.38.0)
            ...(patch ? { before: source, edited: patch } : {}),
            ...(credentialParams.length > 0
              ? { credentialTargetAcknowledged: credentialParams }
              : {}),
          }),
          ipAddress: c.req.header('CF-Connecting-IP') || null,
        }),
      );
    } catch {
      /* skip in tests */
    }

    // BOTH paths: the old URL now 404s but still serves cached bytes (when the
    // route served r2 before the move or after it), and the new URL may hold a
    // cached 404 or a previously-deleted route's body.
    purgeRouteUrlIfR2(c, route.type === 'r2' ? route : source, domain, oldPath);
    purgeRouteUrlIfR2(c, route, domain, newPath);

    return c.json({
      success: true,
      data: route,
      message: `Route migrated from ${oldPath} to ${newPath}`,
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof Error && error.message.includes('already exists')) {
      return c.json({ success: false, error: error.message }, 409);
    }
    if (error instanceof Error && error.message.includes('cannot be the same')) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }
});

/**
 * GET /api/changelog - The engineering changelog, for authenticated callers
 *
 * The dashboard used to `import '../../../CHANGELOG.md?raw'`, which compiled
 * the whole changelog into a JS chunk under `/assets` — served by nginx with no
 * credential check at all, so every release note was readable by anyone who
 * could reach the dashboard host.
 *
 * It is served from the admin chain, so the same `ADMIN_API_KEY` middleware
 * that guards route management applies and an unauthenticated caller gets 401.
 *
 * `private, max-age=300`: a per-browser cache only. It must never become
 * `public` — a shared cache in front of this route would hand the body to
 * unauthenticated callers again, by a different mechanism.
 *
 * The body comes from `src/generated/changelog-text.ts`, generated from
 * CHANGELOG.md by `pnpm run changelog:generate` and freshness-gated in
 * `pnpm run check`.
 */
adminRoutes.get('/changelog', c =>
  c.text(CHANGELOG_MARKDOWN, 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'private, max-age=300',
  }),
);

/**
 * GET /api/backups/health - Check backup system health
 *
 * Returns health status of the R2 backup system including:
 * - Last backup timestamp and age
 * - Manifest validity
 * - File completeness
 * - Route count verification
 *
 * HTTP Status:
 * - 200: whatever R2 or the stored archive does (status conveyed via the JSON
 *   body: an R2 failure or a bad archive is a critical issue there)
 * - 503: BACKUP_BUCKET is not bound
 * - 500: only a programming error, which health rethrows rather than report
 *   as an R2 outage
 */
adminRoutes.get('/backups/health', async c => {
  const bucket = c.env.BACKUP_BUCKET;

  if (!bucket) {
    return c.json(
      {
        success: false,
        error: 'Backup bucket not configured',
      },
      503,
    );
  }

  const health = await checkBackupHealth(bucket);

  // Always return 200 — status conveyed via JSON body field
  // This prevents HTTP error interceptors from hiding the actual health data
  return c.json(health, 200);
});

/**
 * GET /api/metadata/og - Fetch Open Graph metadata for a URL
 *
 * Query params:
 * - url: The URL to fetch OG metadata from
 *
 * Security:
 * - SSRF protection blocks private IPs, localhost, cloud metadata endpoints
 * - Response size limited to 1MB
 * - Request timeout of 5 seconds
 * - Errors answer a fixed message per failure class (describeOpenGraphFailure)
 */
adminRoutes.get('/metadata/og', async c => {
  const url = c.req.query('url');

  if (!url) {
    return c.json(
      {
        success: false,
        error: 'URL query parameter is required',
      },
      400,
    );
  }

  try {
    // A link on one of this Worker's own domains cannot be fetched through
    // the public edge, so those hops are resolved in process (v1.37.2)
    const ogData = await parseOpenGraph(url, { ownHost: ownHostResolver(c.env) });
    return c.json({
      success: true,
      data: ogData,
    });
  } catch (error) {
    // A fixed message per failure class, never the error's own text (v1.38.0)
    const failure = describeOpenGraphFailure(error);
    return c.json(
      { success: false, error: failure.error, details: failure.details },
      failure.status,
    );
  }
});

/**
 * POST /api/routes/transfer - Transfer a route to a different domain
 *
 * Moves a route from one domain to another while preserving:
 * - All route configuration (type, target, options)
 * - Original createdAt timestamp
 *
 * Body parameters:
 * - path: Route path (required)
 * - fromDomain: Source domain (required)
 * - toDomain: Destination domain (required)
 */
adminRoutes.post('/routes/transfer', async c => {
  // The RAW body is kept: the request-only `acknowledgeCredentialTarget` flag
  // is read from it below and is never part of the parsed shape.
  const body: unknown = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });

  // Types first, before any lookup or mutation. The field checks below keep
  // their own messages for a present-but-unusable value.
  const result = TransferRouteRequestSchema.safeParse(body);
  if (!result.success) {
    return c.json(
      {
        success: false,
        error: 'Validation failed',
        details: result.error.issues,
      },
      400,
    );
  }

  const { path, fromDomain, toDomain } = result.data;

  if (!path) {
    return c.json({ success: false, error: 'path is required' }, 400);
  }
  if (!fromDomain) {
    return c.json({ success: false, error: 'fromDomain is required' }, 400);
  }
  if (!toDomain) {
    return c.json({ success: false, error: 'toDomain is required' }, 400);
  }
  if (!path.startsWith('/')) {
    return c.json({ success: false, error: 'path must start with /' }, 400);
  }
  // Transfer checked only the leading slash, so a legacy path that create,
  // update and migrate refuse (`?`, `#`, a surviving `%`, a control character)
  // could still be re-published on a second domain under a key its own listed
  // value can never resolve. Same schema as every other write path.
  const transferPath = RoutePathSchema.safeParse(path);
  if (!transferPath.success) {
    return c.json({ success: false, error: transferPath.error.issues[0].message }, 400);
  }
  if (!isValidDomain(fromDomain)) {
    return c.json(
      {
        success: false,
        error: `Unsupported domain: ${fromDomain}. Supported: ${SUPPORTED_DOMAINS.join(', ')}`,
      },
      400,
    );
  }
  if (!isValidDomain(toDomain)) {
    return c.json(
      {
        success: false,
        error: `Unsupported domain: ${toDomain}. Supported: ${SUPPORTED_DOMAINS.join(', ')}`,
      },
      400,
    );
  }

  // Refused before anything is read
  if (fromDomain === toDomain) {
    return c.json(
      { success: false, error: 'Source and destination domains cannot be the same' },
      400,
    );
  }

  // The source, read ONCE here (v1.38.0): the credential guard uses this
  // record, and transferRoute only confirms it is still the same before
  // writing. A source that has gone is 404 (also one that appears only
  // after this read), one replaced in between 409 ROUTE_SOURCE_CHANGED, an
  // unreadable one 409 ROUTE_RECORD_INVALID (refused here already).
  const existingForTransfer = presentRoute(await getRoute(c.env.ROUTES, fromDomain, path));
  if (!existingForTransfer) {
    throw new HTTPException(404, { message: `Route not found: ${path} on ${fromDomain}` });
  }
  // A transfer cannot CHANGE a target, but it re-publishes it on a different
  // host with a different audience — a link acknowledged for one brand's domain
  // was never acknowledged for another's.
  const transferCredentialParams = credentialTargetParameters(existingForTransfer);
  if (transferCredentialParams.length > 0 && !readCredentialAcknowledgement(body)) {
    return c.json(
      credentialTargetRefusal(transferCredentialParams, "This route's stored target"),
      400,
    );
  }

  try {
    const route = await transferRoute(
      c.env.ROUTES,
      fromDomain,
      toDomain,
      path,
      existingForTransfer,
    );

    if (!route) {
      throw new HTTPException(404, { message: `Route not found: ${path} on ${fromDomain}` });
    }

    // Record audit log
    try {
      const actor = getActorInfo(c);
      c.executionCtx.waitUntil(
        recordAuditLog(c.env.DB, {
          action: 'transfer',
          domain: toDomain,
          path,
          actorLogin: actor.login,
          actorName: actor.name,
          details: JSON.stringify({
            fromDomain,
            toDomain,
            path,
            ...(transferCredentialParams.length > 0
              ? { credentialTargetAcknowledged: transferCredentialParams }
              : {}),
          }),
          ipAddress: c.req.header('CF-Connecting-IP') || null,
        }),
      );
    } catch {
      // executionCtx not available in tests
    }

    // BOTH domains: the source URL now 404s but still serves cached bytes, and
    // the destination URL may hold a cached 404 from before the transfer.
    purgeRouteUrlIfR2(c, route, fromDomain, path);
    purgeRouteUrlIfR2(c, route, toDomain, path);

    return c.json({ success: true, data: route });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('already exists') ? 409 : 400;
    return c.json({ success: false, error: message }, status);
  }
});

/**
 * POST /api/routes/normalize-case - Normalize all route paths to lowercase
 *
 * One-time migration endpoint. Scans all routes across all domains and
 * migrates any routes with non-lowercase paths to their lowercase equivalent.
 * Idempotent — safe to re-run.
 */
adminRoutes.post('/routes/normalize-case', async c => {
  // The readable routes only: an unreadable record's path cannot be known to
  // need lower-casing from its value, and it is never re-keyed (its listing
  // row and the recovery delete are the way to deal with it)
  const { routes: allRoutes } = await listAllDomainRoutes(c.env.ROUTES);
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const route of allRoutes) {
    const lowerPath = route.path.toLowerCase();
    if (route.path === lowerPath) {
      skipped++;
      continue;
    }

    // A legacy path that fails the route-path schema must not be re-keyed here
    // either — that would mint a fresh, still-unmanageable key.
    if (!RoutePathSchema.safeParse(lowerPath).success) {
      errors.push(
        `${routeKey(route.domain, route.path)}: path fails the route-path schema, skipping`,
      );
      continue;
    }

    try {
      const oldKey = routeKey(route.domain, route.path);
      const newKey = routeKey(route.domain, lowerPath);

      // A lower-cased path can be longer in UTF-8 (v1.37.2)
      assertRouteKeyFits(newKey);
      const existingLower = await c.env.ROUTES.get(newKey);
      if (existingLower) {
        errors.push(`${oldKey} → ${newKey}: lowercase route already exists, skipping`);
        continue;
      }

      // Strip the domain field (added by listAllDomainRoutes) — it's not part of the stored value
      const { domain: _domain, ...routeWithoutDomain } = route;

      // The exact key must still hold the record listed above (v1.39.0, the
      // migrate/transfer pattern): one deleted in between is not recreated
      // under the new key, and one replaced or made unreadable in between is
      // neither copied over (the new key would carry the stale listed copy)
      // nor deleted. Nothing is written for any of them. Best effort: KV has
      // no compare-and-set, and a change after this read is not seen.
      const current = await getRouteAtExactKey(c.env.ROUTES, route.domain, route.path);
      if (current.status === 'missing') {
        errors.push(`${oldKey}: ROUTE_NOT_FOUND: deleted while being moved, skipping`);
        continue;
      }
      if (
        current.status === 'invalid' ||
        // The listing replaced any stored `domain` field and stripped it, so
        // the fresh value is compared without one too (a legacy record that
        // stored its own `domain` would otherwise never match)
        canonicalJson(withoutDomainField(current.value)) !== canonicalJson(routeWithoutDomain)
      ) {
        errors.push(`${oldKey}: ROUTE_SOURCE_CHANGED: changed while being moved, skipping`);
        continue;
      }

      const migratedRoute = { ...routeWithoutDomain, path: lowerPath, updatedAt: Date.now() };
      // The exact record, checked immediately before it is written (v1.37.2)
      await c.env.ROUTES.put(newKey, serializeStoredRoute(newKey, migratedRoute));
      await c.env.ROUTES.delete(oldKey);
      migrated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${route.domain}:${route.path}: ${msg}`);
    }
  }

  return c.json({ success: true, data: { migrated, skipped, errors } });
});

/** A stored record without its own `domain` field, which the key already names. */
function withoutDomainField(value: object): Record<string, unknown> {
  const { domain: _domain, ...rest } = value as Record<string, unknown>;
  return rest;
}

/**
 * GET /api/routes/by-target - Find routes by R2 target
 *
 * Returns all R2-type routes pointing to a specific object.
 *
 * Query parameters:
 * - bucket: R2 bucket name (required)
 * - target: R2 object key (required)
 */
adminRoutes.get('/routes/by-target', async c => {
  const bucket = c.req.query('bucket');
  const target = c.req.query('target');

  if (!bucket) {
    return c.json({ success: false, error: 'bucket query parameter is required' }, 400);
  }
  if (!target) {
    return c.json({ success: false, error: 'target query parameter is required' }, 400);
  }

  const routes = await findRoutesByR2Target(c.env.ROUTES, bucket, target);

  return c.json({
    success: true,
    data: { routes },
  });
});

/**
 * Storage API routes
 * Mounted at /api/storage/*
 * Inherits domain restriction, CORS, and auth from parent middleware
 */
adminRoutes.route('/storage', storageRoutes);

/**
 * Analytics API routes
 * Mounted at /api/analytics/*
 * Inherits domain restriction, CORS, and auth from parent middleware
 */
adminRoutes.route('/analytics', analyticsRoutes);

/**
 * Feedback work-queue API routes (v1.26.0)
 * Mounted at /api/feedback/*
 * Inherits domain restriction, CORS, and ADMIN_API_KEY auth from parent middleware
 */
adminRoutes.route('/feedback', feedbackRoutes);

/**
 * QR code API routes (v1.30.0)
 * Mounted at /api/qr/*
 * Inherits domain restriction, CORS, and ADMIN_API_KEY auth from parent middleware
 */
adminRoutes.route('/qr', qrRoutes);
