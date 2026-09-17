import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, KVRouteConfig } from '../types';
import { SUPPORTED_DOMAINS, isValidDomain } from '../types';
import { CreateRouteSchema, UpdateRouteSchema, SCHEMA_VERSION, routeKey } from '../kv/schema';
import {
  getAllRoutes,
  getAllRoutesAllDomains,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  seedRoutes,
  getMetadata,
  migrateRoute,
  transferRoute,
  findRoutesByR2Target,
} from '../kv/routes';
import { validateApiKey } from '../utils/crypto';
import { cors } from '../middleware/cors';
import { analyticsRoutes } from './analytics';
import { storageRoutes } from './storage';
import { feedbackRoutes } from './feedback';
import { qrRoutes } from './qr';
import { recordAuditLog } from '../db/analytics';
import type { AuditAction } from '../db/analytics';
import { checkBackupHealth } from '../backup/health';
import { parseOpenGraph, SSRFBlockedError, ResponseTooLargeError } from '../utils/og-parser';
import { RoutePathSchema, RoutesListQuerySchema, redactSensitive } from '@bifrost/shared';
import { normalizePath } from '../kv/lookup';
import { purgeRouteUrl } from '../utils/cache';
import { findCredentialParams } from '../utils/unified-traffic';
import { CHANGELOG_MARKDOWN } from '../generated/changelog-text';
import {
  getDomainFromRequest,
  getRequiredDomainFromRequest,
  getActorInfo,
} from './request-context';

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
  if (route?.type !== 'r2') return;
  // Purge the CANONICAL path — callers may pass the raw request value
  // ('/Report/'), while the cached URL and the stored route use the normalized
  // form ('/report'). Residual: mixed-case REQUEST-URL variants are separate
  // cache keys and expire via TTL only.
  const canonicalPath = normalizePath(path);

  // Cloudflare's purge-by-URL does not expand wildcards, and purge-by-prefix is
  // an Enterprise feature. Issuing the purge anyway would delete nothing while
  // reporting success — worse than an honest skip, because an operator would
  // believe the cache was cleared.
  if (canonicalPath.includes('*')) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'purge not possible for wildcard route — cached sub-paths expire via TTL',
        domain,
        path: canonicalPath,
      }),
    );
    return;
  }

  try {
    c.executionCtx.waitUntil(
      purgeRouteUrl(domain, canonicalPath, c.env.CLOUDFLARE_API_TOKEN).catch(error => {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'cache purge failed',
            domain,
            path: canonicalPath,
            error: redactSensitive(error instanceof Error ? error.message : String(error)),
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
 * `Route matched` log line carries only the path, the route path and the route
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
  type?: string;
  target?: string;
  enabled?: boolean;
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
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { acknowledgeCredentialTarget?: unknown }).acknowledgeCredentialTarget === true
  );
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
});

/**
 * CORS middleware for cross-origin requests (SECOND - handles preflight without auth)
 * Restricted to trusted origins only
 */
adminRoutes.use(
  '*',
  cors({
    origins: [
      'https://bifrost.example.com',
      'https://example.com',
      'https://bifrost.your-tailnet.ts.net', // Admin dashboard on Tailscale
      'http://localhost:3001', // Local development (API key still required)
    ],
  }),
);

/**
 * API key authentication middleware (SECOND - after CORS handles preflight)
 * Uses timing-safe comparison to prevent timing attacks
 */
adminRoutes.use('*', async (c, next) => {
  // Skip auth for CORS preflight requests
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const apiKey =
    c.req.header('X-Admin-Key') || c.req.header('Authorization')?.replace('Bearer ', '');
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
 * GET /api/routes - List all routes OR get single route
 *
 * List mode (no ?path): Returns all routes for domain (or all domains)
 * Single mode (?path=/linkedin): Returns specific route
 *
 * Supports: X-Domain header, ?domain= query param, ?path= query param
 */
adminRoutes.get('/routes', async c => {
  const pathQuery = c.req.query('path');

  // Single route lookup mode
  if (pathQuery) {
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
    const route = await getRoute(c.env.ROUTES, domain, pathQuery);

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

  // Parse search/pagination query params
  const queryParams = RoutesListQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    search: c.req.query('search'),
    type: c.req.query('type'),
    enabled: c.req.query('enabled'),
  });

  const {
    limit,
    offset,
    search,
    type: typeFilter,
    enabled: enabledFilter,
  } = queryParams.success
    ? queryParams.data
    : { limit: undefined, offset: 0, search: undefined, type: undefined, enabled: undefined };

  // Get all routes for domain(s)
  type RouteWithDomain = KVRouteConfig & { domain?: string };
  let allRoutes: RouteWithDomain[];
  let version: string;
  let updatedAt: number;

  if (domain) {
    const routes = await getAllRoutes(c.env.ROUTES, domain);
    const meta = await getMetadata(c.env.ROUTES, domain);
    allRoutes = routes.map(r => ({ ...r, domain }));
    version = meta?.version ?? SCHEMA_VERSION;
    updatedAt = meta?.updatedAt ?? Date.now();
  } else {
    allRoutes = await getAllRoutesAllDomains(c.env.ROUTES);
    version = SCHEMA_VERSION;
    updatedAt = Date.now();
  }

  // Apply filters
  let filteredRoutes = allRoutes;

  // Search filter: case-insensitive substring match across multiple fields
  if (search) {
    const searchLower = search.toLowerCase();
    filteredRoutes = filteredRoutes.filter(r => {
      const fields = [
        r.path ?? '',
        r.target ?? '',
        r.type ?? '',
        String(r.statusCode ?? ''),
        r.bucket ?? '',
        r.hostHeader ?? '',
      ];
      return fields.some(f => f.toLowerCase().includes(searchLower));
    });
  }

  // Type filter
  if (typeFilter) {
    filteredRoutes = filteredRoutes.filter(r => r.type === typeFilter);
  }

  // Enabled filter
  if (enabledFilter !== undefined) {
    const isEnabled = enabledFilter === 'true';
    filteredRoutes = filteredRoutes.filter(r => (r.enabled !== false) === isEnabled);
  }

  const total = filteredRoutes.length;

  // Apply pagination (only if limit is provided)
  if (limit !== undefined) {
    filteredRoutes = filteredRoutes.slice(offset, offset + limit);
  } else if (offset > 0) {
    filteredRoutes = filteredRoutes.slice(offset);
  }

  return c.json({
    success: true,
    data: {
      routes: filteredRoutes,
      meta: {
        version,
        updatedAt,
        count: filteredRoutes.length,
        total,
        offset,
        hasMore: offset + filteredRoutes.length < total,
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
  const body = await c.req.json();

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

  // Check if route already exists
  const existing = await getRoute(c.env.ROUTES, domain, result.data.path);
  if (existing) {
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
        action: 'create' as AuditAction,
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
  const body = await c.req.json();

  // Validate input
  const result = UpdateRouteSchema.safeParse({ ...body, path });
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

  // Get current route state before update
  const beforeRoute = await getRoute(c.env.ROUTES, domain, path);

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

  const route = await updateRoute(c.env.ROUTES, domain, path, result.data);

  if (!route) {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }

  // Determine if this is a toggle action or general update. The
  // acknowledgement is a request-only flag, not an edited field, so it must not
  // turn a toggle into an 'update' in the audit trail.
  const editedKeys = Object.keys(body).filter(key => key !== 'acknowledgeCredentialTarget');
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
          ...(isToggle ? { enabled: body.enabled } : { before: beforeRoute, after: route }),
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

  // Get route before deletion for audit log
  const routeBeforeDelete = await getRoute(c.env.ROUTES, domain, path);

  const deleted = await deleteRoute(c.env.ROUTES, domain, path);

  if (!deleted) {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }

  // Record audit log (non-blocking) - only if executionCtx is available
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain,
        action: 'delete' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path,
        details: JSON.stringify({ route: routeBeforeDelete }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

  // The route is gone from KV but the edge still serves the file it pointed at.
  purgeRouteUrlIfR2(c, routeBeforeDelete, domain, path);

  return c.json({
    success: true,
    message: `Route deleted: ${path}`,
  });
});

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
  const body = await c.req.json();

  if (!Array.isArray(body.routes)) {
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

  for (const route of body.routes) {
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
      errors.push({ path: route.path, issues: result.error.issues });
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
        action: 'seed' as AuditAction,
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

  try {
    const route = await migrateRoute(c.env.ROUTES, domain, oldPath, newPath);

    if (!route) {
      throw new HTTPException(404, { message: `Route not found: ${oldPath}` });
    }

    // Audit log
    try {
      const actor = getActorInfo(c);
      c.executionCtx.waitUntil(
        recordAuditLog(c.env.DB, {
          domain,
          action: 'migrate' as AuditAction,
          actorLogin: actor.login,
          actorName: actor.name,
          path: newPath,
          details: JSON.stringify({ oldPath, newPath, route }),
          ipAddress: c.req.header('CF-Connecting-IP') || null,
        }),
      );
    } catch {
      /* skip in tests */
    }

    // BOTH paths: the old URL now 404s but still serves cached bytes, and the
    // new URL may hold a cached 404 or a previously-deleted route's body.
    purgeRouteUrlIfR2(c, route, domain, oldPath);
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
 * - 200: Always (status conveyed via JSON body field)
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
    const ogData = await parseOpenGraph(url);
    return c.json({
      success: true,
      data: ogData,
    });
  } catch (error) {
    if (error instanceof SSRFBlockedError) {
      return c.json(
        {
          success: false,
          error: 'URL blocked for security reasons',
          details: error.message,
        },
        403,
      );
    }

    if (error instanceof ResponseTooLargeError) {
      return c.json(
        {
          success: false,
          error: 'Response too large',
          details: error.message,
        },
        413,
      );
    }

    // Network or HTTP errors
    return c.json(
      {
        success: false,
        error: 'Failed to fetch URL',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      502,
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
  const body = await c.req.json<{
    path?: string;
    fromDomain?: string;
    toDomain?: string;
    /** Request-only operator override; never stored. */
    acknowledgeCredentialTarget?: boolean;
  }>();

  const { path, fromDomain, toDomain } = body;

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

  // A transfer cannot CHANGE a target, but it re-publishes it on a different
  // host with a different audience — a link acknowledged for one brand's domain
  // was never acknowledged for another's.
  const existingForTransfer = await getRoute(c.env.ROUTES, fromDomain, path);
  const transferCredentialParams = existingForTransfer
    ? credentialTargetParameters(existingForTransfer)
    : [];
  if (transferCredentialParams.length > 0 && !readCredentialAcknowledgement(body)) {
    return c.json(
      credentialTargetRefusal(transferCredentialParams, "This route's stored target"),
      400,
    );
  }

  try {
    const route = await transferRoute(c.env.ROUTES, fromDomain, toDomain, path);

    if (!route) {
      throw new HTTPException(404, { message: `Route not found: ${path} on ${fromDomain}` });
    }

    // Record audit log
    try {
      const actor = getActorInfo(c);
      c.executionCtx.waitUntil(
        recordAuditLog(c.env.DB, {
          action: 'transfer' as AuditAction,
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
  const allRoutes = await getAllRoutesAllDomains(c.env.ROUTES);
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const route of allRoutes) {
    const lowerPath = route.path.toLowerCase();
    if (route.path === lowerPath) {
      skipped++;
      continue;
    }

    try {
      const oldKey = routeKey(route.domain, route.path);
      const newKey = routeKey(route.domain, lowerPath);

      const existingLower = await c.env.ROUTES.get(newKey);
      if (existingLower) {
        errors.push(`${oldKey} → ${newKey}: lowercase route already exists, skipping`);
        continue;
      }

      // Strip the domain field (added by getAllRoutesAllDomains) — it's not part of the stored value
      const { domain: _domain, ...routeWithoutDomain } = route;
      const migratedRoute = { ...routeWithoutDomain, path: lowerPath, updatedAt: Date.now() };
      await c.env.ROUTES.put(newKey, JSON.stringify(migratedRoute));
      await c.env.ROUTES.delete(oldKey);
      migrated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${route.domain}:${route.path}: ${msg}`);
    }
  }

  return c.json({ success: true, data: { migrated, skipped, errors } });
});

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
 * QR code API routes (v1.30.0 — ported from upstream v1.54.0)
 * Mounted at /api/qr/*
 * Inherits domain restriction, CORS, and ADMIN_API_KEY auth from parent middleware
 */
adminRoutes.route('/qr', qrRoutes);
