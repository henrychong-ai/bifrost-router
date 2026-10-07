import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { clearAllRoutes, seedRoute } from './helpers';

/**
 * No log line carries the visitor's request path or query (v1.39.0). A
 * wildcard or proxy remainder, or anything appended to a link, can carry a
 * secret (a magic-link token in the path), and the request line, the KV
 * lookup line and the `Route matched` line are written on every request.
 * They name the route pattern, the domain and the matched route KEY instead.
 * Every console channel is captured whole.
 */
const ROUTE_HOST = 'links.example.com';
const ADMIN_HOST = 'example.com';
const API_KEY = 'test-api-key-12345';

const bindings = { ...env, ADMIN_API_DOMAIN: ADMIN_HOST } as Bindings;

let lines: string[] = [];

function capture(): void {
  lines = [];
  for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
}

async function send(request: Request): Promise<number> {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, bindings, {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise.catch(() => undefined));
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
  await response.text();
  await Promise.all(pending);
  return response.status;
}

/** The parsed JSON log lines with `message`. */
function logged(message: string): unknown[] {
  return lines
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as unknown)
    .filter(entry => (entry as { message?: unknown }).message === message);
}

describe('request paths stay out of the logs', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    capture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a wildcard hit logs the matched route key, never the remainder or the query', async () => {
    await seedRoute(
      {
        path: '/magic/*',
        type: 'redirect',
        target: 'https://app.example/landing',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ROUTE_HOST,
    );
    const status = await send(
      new Request(`https://${ROUTE_HOST}/magic/SEGMENT-SECRET/more?q=QUERY-SECRET`),
    );
    expect(status).toBe(302);
    expect(logged('Route matched')).toEqual([
      {
        level: 'info',
        message: 'Route matched',
        host: ROUTE_HOST,
        routePath: '/magic/*',
        routeType: 'redirect',
      },
    ]);
    expect(logged('KV lookup')).toEqual([
      { level: 'debug', message: 'KV lookup', domain: ROUTE_HOST, domainSupported: true },
    ]);
    expect(logged('request')).toEqual([
      expect.objectContaining({ route: '/*', method: 'GET', status: 302 }),
    ]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('a proxied wildcard hit logs no remainder, query or upstream URL either', async () => {
    await seedRoute(
      {
        path: '/svc/*',
        type: 'proxy',
        target: 'https://upstream.example.com/base',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ROUTE_HOST,
    );
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('upstream', { status: 200 })));
    const status = await send(
      new Request(`https://${ROUTE_HOST}/svc/REMAINDER-SECRET?token=QUERY-SECRET`),
    );
    expect(status).toBe(200);
    // The control: the remainder did reach the upstream
    expect(String(upstream.mock.calls[0]?.[0])).toContain('REMAINDER-SECRET');
    expect(logged('Route matched')).toEqual([
      expect.objectContaining({ routePath: '/svc/*', routeType: 'proxy' }),
    ]);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('a miss logs no path either', async () => {
    const status = await send(
      new Request(`https://${ROUTE_HOST}/nothing/PATH-SECRET?token=QUERY-SECRET`),
    );
    expect(status).toBe(404);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  // A request log reduced to a "scope" must never pass an unknown first
  // segment through (`/api/<token>`): these lines carry only patterns this
  // Worker registered, whatever the request path is.
  it('an unknown, token-bearing /api path logs a registered pattern only', async () => {
    for (const headers of [{ 'X-Admin-Key': API_KEY }, {}]) {
      lines = [];
      const status = await send(
        new Request(`https://${ADMIN_HOST}/api/TOKEN-SECRET/more/PATH-SECRET?x=QUERY-SECRET`, {
          headers,
        }),
      );
      expect(status).toBeGreaterThanOrEqual(400);
      const requests = logged('request') as Array<{ route?: unknown }>;
      expect(requests).toHaveLength(1);
      expect(typeof requests[0]?.route).toBe('string');
      expect(String(requests[0]?.route)).toMatch(/^\/(?:api\/)?\*$/);
      expect(lines.join('\n')).not.toContain('SECRET');
    }
  });

  it('an admin API request logs its route pattern, never its path values', async () => {
    const status = await send(
      new Request(`https://${ADMIN_HOST}/api/storage/files/meta/KEY-SECRET.pdf?x=QUERY-SECRET`, {
        headers: { 'X-Admin-Key': API_KEY },
      }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(logged('request')).toEqual([
      expect.objectContaining({ route: '/api/storage/:bucket/meta/:key{.+}' }),
    ]);
    expect(lines.join('\n')).not.toContain('SECRET');
  });
});
