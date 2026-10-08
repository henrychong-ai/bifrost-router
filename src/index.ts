import { redactSensitive } from '@bifrost/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import { secureHeaders } from 'hono/secure-headers';
import { pollCfAuditLogs } from './audit/cf-audit-poll';
import { handleScheduled } from './backup';
import { BACKUP_FAILED_GENERIC } from './backup/integrity';
import {
  pruneUnifiedTrafficEvents,
  recordClick,
  recordFileDownload,
  recordPageView,
  recordProxyRequest,
  recordUnifiedTrafficEvent,
  shouldRecordFileDownload,
  type UnifiedTrafficEventType,
} from './db/analytics';
import { CACHE_STATUS_HEADER, handleProxy, handleR2, handleRedirect } from './handlers';
import { proxyDestination } from './handlers/proxy';
import { lookupRoute, rawWildcardRemainder } from './kv/lookup';
import { privacySafeRequestLogger } from './middleware/request-logger';
import { denySensitivePaths } from './middleware/sensitive-paths';
import { handleR2EventBatch, type R2EventMessage } from './queue/r2-events';
import { adminRoutes } from './routes/admin';
import type { AppEnv, Bindings, KVRouteConfig } from './types';
import { getServiceFallback, isValidDomain } from './types';
import { redactRouteTarget } from './utils/credential-redaction';
import { errorName } from './utils/error-name';
import { safeServiceFetch } from './utils/safe-service-fetch';
import {
  boundedUnifiedCacheStatus,
  boundedUnifiedCountry,
  boundedUnifiedLatencyMs,
  classifyUnifiedTraffic,
  isUnifiedTrafficRequestEligible,
  legacyQueryString,
  legacyReferrer,
  parseUnifiedTrafficCutoverAt,
  parseUnifiedTrafficRetentionDays,
  privacySafeUnifiedAnalyticsPath,
  unifiedTrafficOutcome,
} from './utils/unified-traffic';
import { validateProxyTarget } from './utils/url-validation';

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

export function scheduleUnifiedTrafficEvent(
  c: Parameters<typeof handleRedirect>[0],
  startedAt: number,
  domain: string,
  path: string,
  eventType: UnifiedTrafficEventType,
  response: Response,
): void {
  const contentLength = response.headers.get('Content-Length');
  const responseBytes = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  const cf = c.req.raw.cf as CfProperties | undefined;
  c.executionCtx.waitUntil(
    recordUnifiedTrafficEvent(c.env.DB, {
      domain,
      path: privacySafeUnifiedAnalyticsPath(path),
      eventType,
      outcome: unifiedTrafficOutcome(response.status),
      responseStatus: response.status,
      responseBytes,
      cacheStatus: boundedUnifiedCacheStatus(response.headers.get(CACHE_STATUS_HEADER)),
      country: boundedUnifiedCountry(cf?.country),
      trafficClass: classifyUnifiedTraffic(path, c.req.header('user-agent')),
      latencyMs: boundedUnifiedLatencyMs(performance.now() - startedAt),
    }),
  );
}

export async function captureUnifiedTrafficResponse(
  c: Parameters<typeof handleRedirect>[0],
  next: () => Promise<void>,
): Promise<void> {
  // True dormant path: no URL, path, or header work unless explicitly enabled.
  if (c.env.UNIFIED_TRAFFIC_MODE !== 'shadow') {
    await next();
    return;
  }

  const url = new URL(c.req.url);
  if (
    !isUnifiedTrafficRequestEligible({
      mode: c.env.UNIFIED_TRAFFIC_MODE,
      cutoverAt: c.env.UNIFIED_TRAFFIC_CUTOVER_AT,
      hostname: url.hostname,
      adminHostname: c.env.ADMIN_API_DOMAIN,
      path: c.req.path,
      userAgent: c.req.header('user-agent'),
    })
  ) {
    await next();
    return;
  }

  const startedAt = performance.now();
  try {
    await next();
  } catch (error) {
    scheduleUnifiedTrafficEvent(
      c,
      startedAt,
      url.hostname,
      c.req.path,
      c.get('unifiedEventType') ?? 'system',
      new Response(null, { status: 500 }),
    );
    throw error;
  }

  scheduleUnifiedTrafficEvent(
    c,
    startedAt,
    url.hostname,
    c.req.path,
    c.get('unifiedEventType') ?? (c.res.status === 404 ? 'not_found' : 'system'),
    c.res,
  );
}

const app = new Hono<AppEnv>();

// ============================================
// GLOBAL MIDDLEWARE
// ============================================

app.use('*', privacySafeRequestLogger());
app.use('*', captureUnifiedTrafficResponse);

// Return 404 for build-system / source-tree paths and query-string
// path-traversal probes, before the KV catch-all can answer them.
// See docs/cloudflare-waf.md for the companion edge rules.
app.use('*', denySensitivePaths());
app.use(
  '*',
  // 1 year max-age = HSTS-preload-eligible threshold. `includeSubDomains` is
  // intentionally absent — forkers should run a per-subdomain HTTPS audit
  // before adding it (and the `preload` directive).
  secureHeaders({
    strictTransportSecurity: 'max-age=31536000',
    xFrameOptions: 'DENY',
  }),
);

// Permissions-Policy is not supported by Hono's secureHeaders() API, so attach
// it via a separate global middleware. Denies every browser feature this Worker
// and its dashboard don't use.
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'battery=()',
  'camera=()',
  'cross-origin-isolated=()',
  'display-capture=()',
  'encrypted-media=()',
  'execution-while-not-rendered=()',
  'execution-while-out-of-viewport=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'keyboard-map=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'navigation-override=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'sync-xhr=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
  'interest-cohort=()',
  'attribution-reporting=()',
].join(', ');

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
});

// ============================================
// SYSTEM ROUTES (not in KV)
// ============================================

/**
 * Health check endpoint
 */
/**
 * RFC 9116 security contact (`/.well-known/security.txt`).
 *
 * Served before the KV catch-all so it always responds, regardless of any
 * per-domain route configuration, and on every supported domain — the point of
 * an RFC 9116 contact is to be discoverable everywhere.
 *
 * SELF-HOSTERS: set SECURITY_CONTACT_EMAIL in wrangler.toml [vars] to your own
 * address. Without it this serves a placeholder, which is worse than useless —
 * a researcher who finds something real needs a mailbox that exists.
 *
 * `Expires` is 365 days from REQUEST time rather than build time; a build-time
 * value silently ages out between deploys, and RFC 9116 says an expired file
 * should be ignored.
 */
app.get('/.well-known/security.txt', c => {
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const contact = c.env.SECURITY_CONTACT_EMAIL ?? 'security@example.com';
  const url = new URL(c.req.url);

  const body = [
    `Contact: mailto:${contact}`,
    `Expires: ${expiresAt}`,
    'Preferred-Languages: en',
    `Canonical: https://${url.hostname}/.well-known/security.txt`,
    '',
  ].join('\n');

  return c.text(body, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  });
});

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

  // System paths are never routes (v1.39.0: bare /api too). The admin API
  // mount answers /api first (404 off the admin host, 401 without a key), but
  // a request WITH the key falls through to here; served as an ordinary
  // route, a KV route or the service binding stored at /api would get the
  // dashboard proxy's key-bearing request.
  if (path === '/health' || path === '/api' || path.startsWith('/api/')) {
    return c.notFound();
  }

  // Get domain from hostname
  const url = new URL(c.req.url);
  const domain = url.hostname;

  // Debug: Log KV lookup. The domain only, never the visitor's request path
  // (v1.39.0): a wildcard remainder or anything appended can carry a secret.
  console.log(
    JSON.stringify({
      level: 'debug',
      message: 'KV lookup',
      domain,
      domainSupported: isValidDomain(domain),
    }),
  );

  // Look up route in unified KV namespace with domain prefix
  const lookup = await lookupRoute(c.env.ROUTES, domain, path);

  // A stored record that cannot be read is a 404 and nothing else (v1.38.0):
  // never a broader wildcard and never the service binding
  if (lookup.status === 'invalid') {
    c.set('unifiedEventType', 'not_found');
    return c.json({ error: 'Not Found', path }, 404);
  }
  const route = lookup.status === 'ok' ? lookup.route : null;

  if (!route) {
    // Check for service binding fallback (e.g., example-site for example.com)
    const serviceFallback = getServiceFallback(c.env, url.hostname);
    if (serviceFallback) {
      c.set('unifiedEventType', 'service');
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Forwarding to service binding',
          hostname: url.hostname,
        }),
      );
      // Forward the request to the service binding via safeServiceFetch,
      // which wraps the call in try/catch. URL-parse errors (e.g. malformed
      // percent-encoding from scanners) and service-binding failures return
      // null + a warn log; we serve a synthetic 503 in that case rather than
      // letting the throw surface as scriptThrewException on this Worker.
      // (Inner-Worker exceptions resolve as 5xx Responses and pass through.)
      const serviceResponse = await safeServiceFetch(serviceFallback, c.req.raw, {
        hostname: url.hostname,
        adminKey: c.env.ADMIN_API_KEY,
      });
      if (!serviceResponse) {
        // 503: signals an upstream availability problem (binding misconfig,
        // inner-Worker redeploy, OOM, or runtime URL-parse rejection),
        // not "this URL doesn't exist". A 404 here would hide real
        // availability incidents in monitoring and lead to incorrect
        // CDN cache behaviour.
        return c.json({ error: 'Service Unavailable' }, 503);
      }
      // Clone both request and response to avoid immutable headers issue from Hono middleware
      const response = new Response(serviceResponse.body, serviceResponse);

      // Track page views for HTML responses only (not assets like JS, CSS, images)
      const contentType = serviceResponse.headers.get('Content-Type') || '';
      if (contentType.includes('text/html')) {
        const analyticsData = getAnalyticsData(c);
        c.executionCtx.waitUntil(
          recordPageView(c.env.DB, {
            domain: url.hostname,
            path: path,
            ...analyticsData,
            // Sanitised fields are asserted AFTER the spread so a future
            // getAnalyticsData extension can never silently clobber a
            // redaction. Both the query string and the Referer header carry
            // credentials on magic-link / OAuth landing flows.
            queryString: legacyQueryString(url),
            referrer: legacyReferrer(analyticsData.referrer),
          }),
        );
      }

      return response;
    }

    c.set('unifiedEventType', 'not_found');
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

  // A path the route's own handler would refuse (a preservePath or proxy
  // remainder that cannot be aligned or is refused) is a plain 404 here,
  // before any click or proxy analytics is recorded (v1.37.2)
  if (refusesRequestPath(route, url)) {
    c.set('unifiedEventType', 'not_found');
    return c.json({ error: 'Not Found', path }, 404);
  }

  c.set('unifiedEventType', route.type);

  // Log matched route: the host and the matched route KEY, never the
  // visitor's request path (v1.39.0). A wildcard or proxy remainder, or
  // anything a visitor appends, can carry a secret (a magic-link token), and
  // this line is written on every hit.
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Route matched',
      host: url.hostname,
      routePath: route.path,
      routeType: route.type,
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
        targetUrl: redactRouteTarget(route.target),
        ...analyticsData,
        queryString: legacyQueryString(url),
        referrer: legacyReferrer(analyticsData.referrer),
      }),
    );
  }

  // Track R2 routes (file downloads). Gate: GET + status 200 only —
  // `response.ok` also matched 206 (one row per byte-range slice) and a HEAD
  // probe (headers only, no bytes), and a 304 transfers nothing. See
  // shouldRecordFileDownload().
  if (shouldRecordFileDownload(route, response.status, c.req.method)) {
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
        // The key the handler actually served (set before the cache lookup, so
        // a cache HIT is attributed to the object rather than the route target).
        r2Key: c.get('servedR2Key') ?? route.target,
        contentType,
        fileSize,
        cacheStatus,
        ...analyticsData,
        queryString: legacyQueryString(url),
        referrer: legacyReferrer(analyticsData.referrer),
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
        targetUrl: redactRouteTarget(route.target),
        responseStatus: response.status,
        contentType,
        contentLength,
        ...analyticsData,
        queryString: legacyQueryString(url),
        referrer: legacyReferrer(analyticsData.referrer),
      }),
    );
  }

  // Return response immediately (analytics runs in background)
  return response;
});

/**
 * Whether the matched route's handler would refuse this request's path with
 * 404: a redirect whose `preservePath` remainder cannot be aligned with the
 * route's base, or a proxy whose remainder cannot be aligned or is refused
 * segment by segment. A proxy target that fails validation is left to the
 * handler, which answers 502.
 */
function refusesRequestPath(route: KVRouteConfig, url: URL): boolean {
  if (route.type === 'redirect') {
    return (
      route.preservePath === true &&
      route.path.endsWith('/*') &&
      rawWildcardRemainder(url.pathname, route.path) === null
    );
  }
  if (route.type === 'proxy') {
    return validateProxyTarget(route.target).valid && proxyDestination(route, url) === null;
  }
  return false;
}

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
  // Let HTTPException return its intended status code (401, 404, etc.). A
  // coded refusal (CodedHTTPException: ROUTE_RECORD_INVALID, QR_NOT_FOUND,
  // QR_RECORD_INVALID) carries its JSON body as its own response, so it is
  // answered here like any other
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // Handle unexpected errors as 500.
  //
  // The log line names the error's class only (v1.39.0), never its message
  // or stack: those are attacker-influenceable and routinely quote what the
  // failing call held, a credential (an Authorization header echoed by a
  // fetch failure) or the visitor's path and query (a KV read names the
  // `domain:path` key it read, a URL parse the URL), which the redactor
  // cannot know to remove. The development-only diagnostic in the response
  // body still goes through the shared credential redactor.
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Unhandled error',
      errorName: errorName(err),
      // The route pattern that failed, never the request path (v1.39.0)
      route: routePath(c),
      method: c.req.method,
    }),
  );

  return c.json(
    {
      error: 'Internal Server Error',
      message: c.env.ENVIRONMENT === 'development' ? redactSensitive(err.message) : undefined,
    },
    500,
  );
});

// ============================================
// EXPORTS
// ============================================

/**
 * The daily KV backup, logging its outcome; the backup cron's waitUntil work.
 * A failed backup rejects (v1.37.1): the runtime records a rejected waitUntil
 * as the invocation's outcome, so Cron Events and Workers observability show
 * the failure instead of an "ok" run. The rejection and the log line carry
 * handleScheduled's `error`, which is fixed text only (a fixed backup message,
 * else BACKUP_FAILED_GENERIC); a platform error's own text is logged once, by
 * handleScheduled.
 *
 * A re-run is safe. A run that fails before its archive write writes nothing.
 * One whose manifest write fails has already stored an archive it verified; a
 * re-run verifies its own archive again, overwrites the archive, then writes
 * the manifest.
 */
async function runScheduledBackup(env: Bindings): Promise<void> {
  const result = await handleScheduled(env);
  if (result.success) {
    console.log(
      `[Scheduled] Backup completed in ${result.duration}ms - ` +
        `${result.manifest?.kv.totalRoutes} routes`,
    );
    // A run that skipped records still completes (v1.40.0), but says so at
    // error level, counts only (the run's own lines name the keys, never a
    // value), so Workers observability flags it
    const notJson = result.manifest?.kv.skippedNotJson ?? 0;
    const overLineLimit = result.manifest?.kv.skippedOverLineLimit ?? 0;
    if (notJson + overLineLimit > 0) {
      console.error(
        `[Scheduled] Backup skipped ${notJson + overLineLimit} record(s): ` +
          `${notJson} not JSON, ${overLineLimit} over the record line limit`,
      );
    }
    return;
  }
  // handleScheduled always sets `error` on failure; the fallback is a type guard
  const failure = result.error ?? BACKUP_FAILED_GENERIC;
  console.error(`[Scheduled] Backup failed: ${failure}`);
  throw new Error(`Backup failed: ${failure}`);
}

export default {
  /**
   * HTTP request handler (Hono app)
   */
  fetch: app.fetch,

  /**
   * Scheduled event handler — explicit cron dispatch (v1.28.0). The literals
   * MUST match the crons array in wrangler.toml ([triggers]):
   *  - "*\/30 * * * *" → Cloudflare account audit-log poller (Layer 2 of the
   *    external R2 audit capture; no-ops unless CF_AUDIT_POLL="on")
   *  - "0 20 * * *" → daily KV backup (8 PM UTC / 4 AM SGT). An empty cron
   *    (manual trigger / `wrangler dev --test-scheduled`) also runs the backup,
   *    preserving the pre-v1.28.0 manual-test behaviour.
   *  - anything else → loud warning, NO handler. Falling through to the backup
   *    here would silently run it at the unknown cron's cadence (e.g. 48×/day
   *    after a poller-cadence retune) while the intended handler never fires.
   */
  scheduled: async (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    if (event.cron === '*/30 * * * *') {
      ctx.waitUntil(pollCfAuditLogs(env));
      return;
    }
    if (event.cron === '0 20 * * *' || !event.cron) {
      const cutoverAt = parseUnifiedTrafficCutoverAt(env.UNIFIED_TRAFFIC_CUTOVER_AT);
      const retentionDays = parseUnifiedTrafficRetentionDays(env.UNIFIED_TRAFFIC_RETENTION_DAYS);
      // Two waitUntil calls, not one Promise.all: a failed backup rejects its
      // own promise, and the prune stays tracked until it finishes.
      ctx.waitUntil(runScheduledBackup(env));
      if (
        cutoverAt !== null &&
        retentionDays !== null &&
        cutoverAt <= Math.floor(Date.now() / 1000)
      ) {
        ctx.waitUntil(pruneUnifiedTrafficEvents(env.DB, retentionDays));
      }
      return;
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'scheduled-unknown-cron',
        cron: event.cron,
        hint: 'No handler mapped — update the dispatch in src/index.ts to match wrangler.toml crons',
      }),
    );
  },

  /**
   * Queue consumer for R2 event notifications (v1.28.0) — external R2
   * operations audit capture. Flag-gated by R2_EVENT_AUDIT ("on" to record;
   * anything else acks and discards).
   */
  queue: async (batch: MessageBatch<R2EventMessage>, env: Bindings, _ctx: ExecutionContext) => {
    await handleR2EventBatch(batch, env);
  },
};
