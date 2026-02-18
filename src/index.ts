import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Bindings, KVRouteConfig } from './types';
import { getServiceFallback, isValidDomain } from './types';
import { matchRoute } from './kv/lookup';
import { handleRedirect, handleProxy, handleR2, CACHE_STATUS_HEADER } from './handlers';
import { adminRoutes } from './routes/admin';
import {
  recordClick,
  recordPageView,
  recordFileDownload,
  recordProxyRequest,
} from './db/analytics';
import { handleScheduled } from './backup';

/**
 * Cloudflare request cf properties we use for analytics
 */
interface CfProperties {
  country?: string;
  city?: string;
  colo?: string;
  continent?: string;
  httpProtocol?: string;
  timezone?: string;
}

/**
 * Extract analytics data from request context
 */
function getAnalyticsData(c: {
  req: { raw: Request; header: (name: string) => string | undefined };
}) {
  const cf = c.req.raw.cf as CfProperties | undefined;
  return {
    referrer: c.req.header('referer'),
    userAgent: c.req.header('user-agent'),
    country: cf?.country,
    city: cf?.city,
    colo: cf?.colo,
    continent: cf?.continent,
    httpProtocol: cf?.httpProtocol,
    timezone: cf?.timezone,
    ipAddress: c.req.header('cf-connecting-ip'),
  };
}

const app = new Hono<AppEnv>();

// ============================================
// GLOBAL MIDDLEWARE
// ============================================

app.use('*', logger());
app.use(
  '*',
  secureHeaders({
    strictTransportSecurity: 'max-age=15552000',
  }),
);

// ============================================
// SYSTEM ROUTES (not in KV)
// ============================================

/**
 * Health check endpoint
 */
app.get('/health', c => {
  const url = new URL(c.req.url);
  const isDomainSupported = isValidDomain(url.hostname);

  return c.json({
    status: 'ok',
    version: c.env.VERSION,
    timestamp: Date.now(),
    env: c.env.ENVIRONMENT,
    hostname: url.hostname,
    domainSupported: isDomainSupported,
  });
});

/**
 * Admin API for route management
 */
app.route('/api', adminRoutes);

// ============================================
// KV-BASED DYNAMIC ROUTING
// ============================================

/**
 * Main router - matches requests against KV-stored routes
 *
 * This catch-all handler:
 * 1. Determines KV namespace based on request hostname
 * 2. Looks up the request path in the appropriate KV
 * 3. Matches exact paths first, then wildcards
 * 4. Delegates to appropriate handler based on route type
 */
app.all('*', async c => {
  const path = c.req.path;

  // Skip system routes
  if (path === '/health' || path.startsWith('/api/')) {
    return c.notFound();
  }

  // Get domain from hostname
  const url = new URL(c.req.url);
  const domain = url.hostname;

  // Debug: Log KV lookup
  console.log(
    JSON.stringify({
      level: 'debug',
      message: 'KV lookup',
      domain,
      path,
      domainSupported: isValidDomain(domain),
    }),
  );

  // Look up route in unified KV namespace with domain prefix
  const route = await matchRoute(c.env.ROUTES, domain, path);

  if (!route) {
    // Check for service binding fallback (e.g., henrychong-site for henrychong.com)
    const serviceFallback = getServiceFallback(c.env, url.hostname);
    if (serviceFallback) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Forwarding to service binding',
          hostname: url.hostname,
          path,
        }),
      );
      // Forward the request to the service binding
      // Clone both request and response to avoid immutable headers issue from Hono middleware
      const serviceResponse = await serviceFallback.fetch(new Request(c.req.raw));
      const response = new Response(serviceResponse.body, serviceResponse);

      // Track page views for HTML responses only (not assets like JS, CSS, images)
      const contentType = serviceResponse.headers.get('Content-Type') || '';
      if (contentType.includes('text/html')) {
        const analyticsData = getAnalyticsData(c);
        c.executionCtx.waitUntil(
          recordPageView(c.env.DB, {
            domain: url.hostname,
            path: path,
            queryString: url.search || null,
            ...analyticsData,
          }),
        );
      }

      return response;
    }

    return c.json(
      {
        error: 'Not Found',
        path,
        message: 'No route configured for this path.',
        hint: 'Use the admin API to add routes: POST /api/routes',
      },
      404,
    );
  }

  // Log matched route
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Route matched',
      path,
      routePath: route.path,
      routeType: route.type,
      target: route.target,
    }),
  );

  // Delegate to appropriate handler and get response
  const response = await handleRoute(c, route);

  // Record analytics asynchronously AFTER response is prepared
  const analyticsData = getAnalyticsData(c);

  // Track redirect routes (link clicks)
  if (route.type === 'redirect') {
    c.executionCtx.waitUntil(
      recordClick(c.env.DB, {
        domain: url.hostname,
        slug: path,
        targetUrl: route.target,
        queryString: url.search || null,
        ...analyticsData,
      }),
    );
  }

  // Track R2 routes (file downloads)
  if (route.type === 'r2' && response.ok) {
    // Extract file metadata from response headers
    const contentType = response.headers.get('Content-Type') || undefined;
    const contentLength = response.headers.get('Content-Length');
    const fileSize = contentLength ? parseInt(contentLength, 10) : undefined;
    // Get cache status (HIT/MISS) from X-Cache-Status header
    const cacheStatus = response.headers.get(CACHE_STATUS_HEADER) as 'HIT' | 'MISS' | null;

    c.executionCtx.waitUntil(
      recordFileDownload(c.env.DB, {
        domain: url.hostname,
        path: path,
        r2Key: route.target,
        contentType,
        fileSize,
        cacheStatus,
        queryString: url.search || null,
        ...analyticsData,
      }),
    );
  }

  // Track proxy routes
  if (route.type === 'proxy') {
    // Extract response metadata from headers
    const contentType = response.headers.get('Content-Type') || undefined;
    const contentLengthHeader = response.headers.get('Content-Length');
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;

    c.executionCtx.waitUntil(
      recordProxyRequest(c.env.DB, {
        domain: url.hostname,
        path: path,
        targetUrl: route.target,
        responseStatus: response.status,
        contentType,
        contentLength,
        queryString: url.search || null,
        ...analyticsData,
      }),
    );
  }

  // Return response immediately (analytics runs in background)
  return response;
});

/**
 * Route handler dispatcher
 */
async function handleRoute(
  c: Parameters<typeof handleRedirect>[0],
  route: KVRouteConfig,
): Promise<Response> {
  switch (route.type) {
    case 'redirect':
      return handleRedirect(c, route);

    case 'proxy':
      return handleProxy(c, route);

    case 'r2':
      return handleR2(c, route);

    default:
      return c.json(
        {
          error: 'Invalid route type',
          type: route.type,
        },
        500,
      );
  }
}

// ============================================
// ERROR HANDLING
// ============================================

app.onError((err, c) => {
  // Let HTTPException return its intended status code (401, 404, etc.)
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // Handle unexpected errors as 500
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Unhandled error',
      error: err.message,
      stack: c.env.ENVIRONMENT === 'development' ? err.stack : undefined,
      path: c.req.path,
      method: c.req.method,
    }),
  );

  return c.json(
    {
      error: 'Internal Server Error',
      message: c.env.ENVIRONMENT === 'development' ? err.message : undefined,
    },
    500,
  );
});

// ============================================
// EXPORTS
// ============================================

export default {
  /**
   * HTTP request handler (Hono app)
   */
  fetch: app.fetch,

  /**
   * Scheduled event handler for cron-triggered backups
   * Runs daily at 8 PM UTC (4 AM SGT)
   */
  scheduled: async (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(
      handleScheduled(env).then(result => {
        if (result.success) {
          console.log(
            `[Scheduled] Backup completed in ${result.duration}ms - ` +
              `${result.manifest?.kv.totalRoutes} routes, ${result.manifest?.d1.totalRows} rows`,
          );
        } else {
          console.error(`[Scheduled] Backup failed: ${result.error}`);
        }
      }),
    );
  },
};
