import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { createDb } from '../db';
import {
  getAnalyticsSummary,
  getClicks,
  getViews,
  getSlugStats,
  getDownloads,
  getDownloadStats,
  getProxyRequests,
  getProxyStats,
  getAuditLogs,
} from '../db/queries';

/**
 * Analytics API routes
 *
 * All endpoints inherit auth from parent admin routes.
 * Rate limiting handled by Cloudflare WAF.
 */
export const analyticsRoutes = new Hono<AppEnv>();

/**
 * Query params schema for summary endpoint
 */
const SummaryQuerySchema = z.object({
  domain: z.string().optional(),
  days: z.coerce.number().min(1).max(365).default(30),
});

/**
 * Query params schema for list endpoints
 */
const ListQuerySchema = z.object({
  domain: z.string().optional(),
  days: z.coerce.number().min(1).max(365).default(30),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
  slug: z.string().optional(),
  path: z.string().optional(),
  country: z.string().length(2).toUpperCase().optional(),
});

/**
 * Query params schema for slug stats endpoint
 */
const SlugQuerySchema = z.object({
  domain: z.string().optional(),
  days: z.coerce.number().min(1).max(365).default(30),
});

/**
 * Query params schema for downloads list endpoint
 */
const DownloadsListQuerySchema = z.object({
  domain: z.string().optional(),
  days: z.coerce.number().min(1).max(365).default(30),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
  path: z.string().optional(),
  r2Key: z.string().optional(),
  country: z.string().length(2).toUpperCase().optional(),
});

/**
 * Query params schema for proxy list endpoint
 */
const ProxyListQuerySchema = z.object({
  domain: z.string().optional(),
  days: z.coerce.number().min(1).max(365).default(30),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
  path: z.string().optional(),
  targetUrl: z.string().optional(),
  country: z.string().length(2).toUpperCase().optional(),
});

/**
 * Query params schema for audit logs endpoint
 */
const AuditListQuerySchema = z.object({
  domain: z.string().optional(),
  action: z.enum(['create', 'update', 'delete', 'toggle', 'seed']).optional(),
  actor: z.string().optional(),
  path: z.string().optional(),
  days: z.coerce.number().min(1).max(365).default(30),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * GET /api/analytics/summary
 *
 * Returns aggregate statistics for dashboard overview.
 * Includes totals, top items, time series data, and recent activity.
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 */
analyticsRoutes.get('/summary', async (c) => {
  const queryResult = SummaryQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const summary = await getAnalyticsSummary(db, queryResult.data);

    return c.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics summary query failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch analytics summary',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/clicks
 *
 * Returns paginated list of link clicks with filtering.
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 * - limit: Results per page (default: 100, max: 1000)
 * - offset: Pagination offset (default: 0)
 * - slug: Filter by slug (optional)
 * - country: Filter by country code (optional, 2-letter ISO)
 */
analyticsRoutes.get('/clicks', async (c) => {
  const queryResult = ListQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    slug: c.req.query('slug'),
    country: c.req.query('country'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const result = await getClicks(db, queryResult.data);

    // Add total count header for pagination
    c.header('X-Total-Count', String(result.meta.total));

    return c.json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics clicks query failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch click analytics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/views
 *
 * Returns paginated list of page views with filtering.
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 * - limit: Results per page (default: 100, max: 1000)
 * - offset: Pagination offset (default: 0)
 * - path: Filter by path (optional)
 * - country: Filter by country code (optional, 2-letter ISO)
 */
analyticsRoutes.get('/views', async (c) => {
  const queryResult = ListQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    path: c.req.query('path'),
    country: c.req.query('country'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const result = await getViews(db, queryResult.data);

    // Add total count header for pagination
    c.header('X-Total-Count', String(result.meta.total));

    return c.json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics views query failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch view analytics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/clicks/:slug
 *
 * Returns detailed statistics for a specific link slug.
 *
 * Path params:
 * - slug: The link slug (URL-encoded if contains special chars)
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 */
analyticsRoutes.get('/clicks/:slug', async (c) => {
  const slug = '/' + c.req.param('slug');

  const queryResult = SlugQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const stats = await getSlugStats(db, slug, queryResult.data);

    if (stats.totalClicks === 0) {
      return c.json(
        {
          success: false,
          error: `No clicks found for slug: ${slug}`,
        },
        404
      );
    }

    return c.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics slug stats query failed',
        error: error instanceof Error ? error.message : String(error),
        slug,
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch slug statistics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/downloads
 *
 * Returns paginated list of file downloads with filtering.
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 * - limit: Results per page (default: 100, max: 1000)
 * - offset: Pagination offset (default: 0)
 * - path: Filter by path (optional)
 * - r2Key: Filter by R2 key (optional)
 * - country: Filter by country code (optional, 2-letter ISO)
 */
analyticsRoutes.get('/downloads', async (c) => {
  const queryResult = DownloadsListQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    path: c.req.query('path'),
    r2Key: c.req.query('r2Key'),
    country: c.req.query('country'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const result = await getDownloads(db, queryResult.data);

    // Add total count header for pagination
    c.header('X-Total-Count', String(result.meta.total));

    return c.json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics downloads query failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch download analytics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/downloads/:path
 *
 * Returns detailed statistics for a specific file download path.
 *
 * Path params:
 * - path: The download path (URL-encoded if contains special chars)
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 */
analyticsRoutes.get('/downloads/:path{.+}', async (c) => {
  const path = '/' + c.req.param('path');

  const queryResult = SlugQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const stats = await getDownloadStats(db, path, queryResult.data);

    if (stats.totalDownloads === 0) {
      return c.json(
        {
          success: false,
          error: `No downloads found for path: ${path}`,
        },
        404
      );
    }

    return c.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics download stats query failed',
        error: error instanceof Error ? error.message : String(error),
        path,
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch download statistics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/proxy
 *
 * Returns paginated list of proxy requests with filtering.
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 * - limit: Results per page (default: 100, max: 1000)
 * - offset: Pagination offset (default: 0)
 * - path: Filter by path (optional)
 * - targetUrl: Filter by target URL (optional)
 * - country: Filter by country code (optional, 2-letter ISO)
 */
analyticsRoutes.get('/proxy', async (c) => {
  const queryResult = ProxyListQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    path: c.req.query('path'),
    targetUrl: c.req.query('targetUrl'),
    country: c.req.query('country'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const result = await getProxyRequests(db, queryResult.data);

    // Add total count header for pagination
    c.header('X-Total-Count', String(result.meta.total));

    return c.json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics proxy query failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch proxy analytics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/proxy/:path
 *
 * Returns detailed statistics for a specific proxy path.
 *
 * Path params:
 * - path: The proxy path (URL-encoded if contains special chars)
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - days: Time range in days (default: 30, max: 365)
 */
analyticsRoutes.get('/proxy/:path{.+}', async (c) => {
  const path = '/' + c.req.param('path');

  const queryResult = SlugQuerySchema.safeParse({
    domain: c.req.query('domain'),
    days: c.req.query('days'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const stats = await getProxyStats(db, path, queryResult.data);

    if (stats.totalRequests === 0) {
      return c.json(
        {
          success: false,
          error: `No proxy requests found for path: ${path}`,
        },
        404
      );
    }

    return c.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics proxy stats query failed',
        error: error instanceof Error ? error.message : String(error),
        path,
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch proxy statistics',
      },
      500
    );
  }
});

/**
 * GET /api/analytics/audit
 *
 * Returns paginated list of audit logs with filtering.
 *
 * Query params:
 * - domain: Filter by domain (optional)
 * - action: Filter by action type: create, update, delete, toggle, seed (optional)
 * - actor: Filter by actor login (optional)
 * - path: Search by path (optional)
 * - days: Time range in days (default: 30, max: 365)
 * - limit: Results per page (default: 100, max: 1000)
 * - offset: Pagination offset (default: 0)
 */
analyticsRoutes.get('/audit', async (c) => {
  const queryResult = AuditListQuerySchema.safeParse({
    domain: c.req.query('domain'),
    action: c.req.query('action'),
    actor: c.req.query('actor'),
    path: c.req.query('path'),
    days: c.req.query('days'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });

  if (!queryResult.success) {
    return c.json(
      {
        success: false,
        error: 'Invalid query parameters',
        details: queryResult.error.issues,
      },
      400
    );
  }

  try {
    const db = createDb(c.env.DB);
    const result = await getAuditLogs(db, queryResult.data);

    // Add total count header for pagination
    c.header('X-Total-Count', String(result.meta.total));

    return c.json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Analytics audit query failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return c.json(
      {
        success: false,
        error: 'Failed to fetch audit logs',
      },
      500
    );
  }
});
