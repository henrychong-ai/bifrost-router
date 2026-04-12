import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, KVRouteConfig } from '../types';
import { SUPPORTED_DOMAINS, isValidDomain } from '../types';
import { CreateRouteSchema, UpdateRouteSchema, SCHEMA_VERSION } from '../kv/schema';
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
import { recordAuditLog } from '../db/analytics';
import type { AuditAction } from '../db/analytics';
import { checkBackupHealth } from '../backup/health';
import { parseOpenGraph, SSRFBlockedError, ResponseTooLargeError } from '../utils/og-parser';
import { RoutesListQuerySchema } from '@bifrost/shared';

/**
 * Result of parsing domain from request
 */
type DomainParseResult =
  | { valid: true; domain: string | undefined }
  | { valid: false; error: string; domain?: undefined };

/**
 * Get target domain from request (for listing routes)
 * Priority: X-Domain header > ?domain query param > undefined (all domains)
 * Returns validation result including whether an invalid domain was provided
 */
function getDomainFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): DomainParseResult {
  // Check X-Domain header first
  const domainHeader = c.req.header('X-Domain');
  if (domainHeader) {
    if (isValidDomain(domainHeader)) {
      return { valid: true, domain: domainHeader };
    }
    return { valid: false, error: `Invalid domain: ${domainHeader}` };
  }

  // Check query parameter
  const domainQuery = c.req.query('domain');
  if (domainQuery) {
    if (isValidDomain(domainQuery)) {
      return { valid: true, domain: domainQuery };
    }
    return { valid: false, error: `Invalid domain: ${domainQuery}` };
  }

  // Return undefined for "all domains" mode
  return { valid: true, domain: undefined };
}

/**
 * Result of parsing required domain from request
 */
type RequiredDomainParseResult =
  | { valid: true; domain: string }
  | { valid: false; error: string; domain?: undefined };

/**
 * Get target domain from request (required for mutations)
 * Priority: X-Domain header > ?domain query param > ADMIN_API_DOMAIN env var > example.com fallback
 * Returns validation result - if invalid domain provided, returns validation failure
 */
function getRequiredDomainFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
  env: { ADMIN_API_DOMAIN?: string };
}): RequiredDomainParseResult {
  const result = getDomainFromRequest(c);
  if (!result.valid) {
    // Invalid domain provided - caller should return 400
    return result;
  }
  // Default to ADMIN_API_DOMAIN from env, or 'example.com' as fallback
  const defaultDomain = c.env.ADMIN_API_DOMAIN || 'example.com';
  return { valid: true, domain: result.domain ?? defaultDomain };
}

/**
 * Get actor info from Tailscale headers
 */
function getActorInfo(c: { req: { header: (name: string) => string | undefined } }): {
  login: string;
  name: string | null;
} {
  const login = c.req.header('Tailscale-User-Login') || 'api-key';
  const name = c.req.header('Tailscale-User-Name') || null;
  return { login, name };
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

  // Check for case-insensitive path conflict
  const allRoutes = await getAllRoutes(c.env.ROUTES, domain);
  const pathLower = result.data.path.toLowerCase();
  const caseConflict = allRoutes.find(
    r => r.path.toLowerCase() === pathLower && r.path !== result.data.path,
  );
  if (caseConflict) {
    return c.json(
      {
        success: false,
        error: `Case conflict: ${caseConflict.path} already exists (paths are case-insensitive)`,
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
        details: JSON.stringify({ route }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

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

  const route = await updateRoute(c.env.ROUTES, domain, path, result.data);

  if (!route) {
    throw new HTTPException(404, { message: `Route not found: ${path}` });
  }

  // Determine if this is a toggle action or general update
  const isToggle = Object.keys(body).length === 1 && 'enabled' in body;
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
        details: isToggle
          ? JSON.stringify({ enabled: body.enabled })
          : JSON.stringify({ before: beforeRoute, after: route }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available (e.g., in tests) - skip audit logging
  }

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

  for (const route of body.routes) {
    const result = CreateRouteSchema.safeParse(route);
    if (result.success) {
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

  const result = await seedRoutes(c.env.ROUTES, domain, validRoutes);

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
          details: JSON.stringify({ fromDomain, toDomain, path }),
          ipAddress: c.req.header('CF-Connecting-IP') || null,
        }),
      );
    } catch {
      // executionCtx not available in tests
    }

    return c.json({ success: true, data: route });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('already exists') ? 409 : 400;
    return c.json({ success: false, error: message }, status);
  }
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
