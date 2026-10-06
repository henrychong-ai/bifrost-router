/**
 * Own-domain previews must treat as "answered by the Worker" exactly the paths
 * src/index.ts answers before its KV catch-all, no more and no fewer (v1.37.2).
 * A path the resolver wrongly calls Worker-answered previews as nothing while
 * a visitor gets the route; one it wrongly resolves would describe a route no
 * visitor can reach.
 *
 * Two checks: every registration in src/index.ts is pinned to a list that
 * names how the resolver covers each, so a new top-level route fails here
 * until the resolver is updated; and every probe path is sent through the real
 * Worker and through the resolver, with the same environment, and both must
 * agree on whether the KV route stored at that path is what answers.
 */

import { env } from 'cloudflare:test';
import { getPath } from 'hono/utils/url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import indexSource from '../../src/index.ts?raw';
import { normalizePath } from '../../src/kv/lookup';
import type { Bindings } from '../../src/types';
import {
  isWorkerAnsweredPath,
  ownHostResolver,
  WORKER_ANSWERED_EXACT_PATHS,
  WORKER_ANSWERED_PREFIXES,
} from '../../src/utils/og-own-host';
import { clearAllRoutes, createSettlingExecutionContext, seedRoute } from '../helpers';

const HOST = 'links.example.com';
const MARKER = 'https://dest.example.net/from-route';

/** Every top-level `app.<method>(` call in src/index.ts except `app.use`, as written. */
function registrations(): string[] {
  return [...indexSource.matchAll(/^app\.(\w+)\(([^\n]*)/gm)]
    .filter(([, method]) => method !== 'use')
    .map(([, method, rest]) => `${method}(${(rest ?? '').split(',')[0]?.trim()}`);
}

describe('own-host preview parity with src/index.ts', () => {
  it('knows every registration src/index.ts makes before its routes', () => {
    // Each registration, and where the resolver accounts for it
    expect(registrations()).toEqual([
      "get('/.well-known/security.txt'", // WORKER_ANSWERED_EXACT_PATHS
      "get('/health'", // WORKER_ANSWERED_EXACT_PATHS (and the catch-all's own check)
      "route('/api'", // '/api' (EXACT) and WORKER_ANSWERED_PREFIXES '/api/'
      "all('*'", // the KV catch-all the resolver mirrors
      'onError((err', // error handling, answers no path of its own
    ]);
    // No registration chained onto another, or continued on the next line
    expect(indexSource).not.toMatch(
      /^app\.\w+\([^\n]*\)\s*\.(get|post|put|patch|delete|all|on|options|route|mount)\(/m,
    );
    expect(indexSource).not.toMatch(
      /^\s+\.(get|post|put|patch|delete|all|on|options|route|mount|basePath)\(\s*['"[]/m,
    );
    expect(WORKER_ANSWERED_EXACT_PATHS).toEqual(['/.well-known/security.txt', '/health', '/api']);
    expect(WORKER_ANSWERED_PREFIXES).toEqual(['/api/']);
    // The catch-all's own early exit, which the lists above mirror
    expect(indexSource).toContain("if (path === '/health' || path.startsWith('/api/')) {");
    // Global middleware: denySensitivePaths is the one that answers before
    // routing (isSensitivePath); a new app.use must be reviewed here
    expect(indexSource.match(/^app\.use\(/gm)).toHaveLength(5);
    expect(indexSource).toContain("app.use('*', denySensitivePaths());");
  });

  describe('agrees with the running Worker', () => {
    beforeEach(async () => {
      await clearAllRoutes();
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(
          async () =>
            new Response('<title>Route</title>', { headers: { 'content-type': 'text/html' } }),
        ),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // [path and query, admin host]: the admin host decides the traversal-query
    // refusal and the admin API's own answers
    it.each([
      ['/health', 'bifrost.example.com'],
      ['/Health', 'bifrost.example.com'],
      ['/api', 'bifrost.example.com'],
      ['/api', HOST],
      ['/api/', 'bifrost.example.com'],
      ['/api/routes', 'bifrost.example.com'],
      ['/API', 'bifrost.example.com'],
      ['/API/routes', 'bifrost.example.com'],
      ['/%61pi/routes', 'bifrost.example.com'],
      ['/api%2Froutes', 'bifrost.example.com'],
      ['/.well-known/security.txt', 'bifrost.example.com'],
      ['/.well-known/other', 'bifrost.example.com'],
      ['/.WELL-KNOWN/security.txt', 'bifrost.example.com'],
      ['/wrangler.toml', 'bifrost.example.com'],
      ['/WRANGLER.TOML', 'bifrost.example.com'],
      ['/src/index.ts', 'bifrost.example.com'],
      ['/?file=../x', HOST],
      ['/?file=../x', 'bifrost.example.com'],
      ['/promo?file=../x', HOST],
      ['/promo', 'bifrost.example.com'],
    ])('%s with the admin host %s', async (pathAndQuery, adminHost) => {
      const url = new URL(`https://${HOST}${pathAndQuery}`);
      // Stored under the key the lookup itself resolves, so a route that is
      // not served is shadowed, not merely missing
      await seedRoute(
        { path: normalizePath(url.pathname), type: 'redirect', target: MARKER, enabled: true },
        HOST,
      );
      const testEnv = { ...env, ADMIN_API_DOMAIN: adminHost } as unknown as Bindings;

      const { ctx, settled } = createSettlingExecutionContext();
      const visitor = await worker.fetch(
        new Request(url.href, { redirect: 'manual' }),
        testEnv,
        ctx,
      );
      await visitor.body?.cancel();
      await settled();
      const routeAnswers = visitor.headers.get('location')?.startsWith(MARKER) === true;

      // The path as the router sees it (Hono's decoded `c.req.path`)
      const routerPath = getPath({ url: url.href } as Request);
      expect(isWorkerAnsweredPath(routerPath, url.search, HOST, testEnv)).toBe(!routeAnswers);
      const answer = await ownHostResolver(testEnv).resolve(url, new AbortController().signal);
      const resolverRouteAnswers =
        answer.kind === 'response' &&
        answer.response.headers.get('location')?.startsWith(MARKER) === true;
      expect(resolverRouteAnswers).toBe(routeAnswers);
    });
  });
});
