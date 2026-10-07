import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings, KVRouteConfig } from '../src/types';
import { isRecord } from '../src/utils/boundary';
import { clearAllRoutes, seedRoute } from './helpers';

/**
 * A stored proxy target can carry a credential, and it is never written to a
 * log or an answer when the target is refused (v1.38.0). The proxy target
 * check's messages are fixed text: an unparseable target, a refused scheme and
 * a private address never quote the target, its host or its query. Every
 * console channel is captured whole, for the visitor request, the admin
 * create and update and the link previews.
 */
const ROUTE_HOST = 'links.example.com';
const ADMIN_HOST = 'example.com';
const API_KEY = 'test-api-key-12345';

const bindings = { ...env, ADMIN_API_DOMAIN: ADMIN_HOST } as Bindings;

const TARGETS = [
  ['an unparseable target', 'not-an-absolute-url?token=SECRET-UNPARSED'],
  ['a refused scheme', 'ftp://files.example.net/x?token=SECRET-SCHEME'],
  ['a private address', 'http://10.0.0.1/x?token=SECRET-PRIVATE'],
  ['a refused name', 'http://printer.local/x?token=SECRET-NAME'],
] as const;

let lines: string[] = [];
let pending: Promise<unknown>[] = [];

function capture(): void {
  lines = [];
  for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
}

async function send(request: Request): Promise<{ status: number; body: string }> {
  pending = [];
  const response = await worker.fetch(request, bindings, {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise.catch(() => undefined));
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
  const body = await response.text();
  await Promise.all(pending);
  return { status: response.status, body };
}

const admin = (method: string, path: string, body?: unknown) =>
  new Request(`https://${ADMIN_HOST}${path}`, {
    method,
    headers: { 'X-Admin-Key': API_KEY, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function proxyRoute(path: string, target: string): KVRouteConfig {
  return { path, type: 'proxy', target, enabled: true, createdAt: 1, updatedAt: 1 };
}

/**
 * An admin write answers with the route it stored, the caller's own target
 * included (the API contract); everything else in the answer, a refusal
 * included, must not quote it.
 */
function withoutEcho(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (isRecord(parsed) && isRecord(parsed['data'])) {
    return JSON.stringify({ ...parsed, data: { ...parsed['data'], target: undefined } });
  }
  return body;
}

/** The secret marker of a target: what must appear nowhere. */
const secretOf = (target: string) => target.slice(target.indexOf('SECRET'));

describe('a refused proxy target never reaches a log or an answer', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    capture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(TARGETS)(
    'serving %s answers fixed text and logs no part of it',
    async (_label, target) => {
      await seedRoute(proxyRoute('/svc', target), ROUTE_HOST);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const { status, body } = await send(new Request(`https://${ROUTE_HOST}/svc?v=1`));
      expect(status).toBe(502);
      expect(JSON.parse(body)).toEqual({
        error: 'Bad Gateway',
        message: 'The proxy target is not allowed.',
        type: 'validation_error',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      const output = lines.join('\n');
      expect(output).toContain('Proxy validation_error');
      expect(output).not.toContain(secretOf(target));
      expect(output).not.toContain('SECRET');
      expect(body).not.toContain('SECRET');
    },
  );

  it('a redirect hop to a refused target logs no part of it', async () => {
    await seedRoute(proxyRoute('/hop', 'https://upstream.example.net/start'), ROUTE_HOST);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.1/next?token=SECRET-HOP' },
      }),
    );
    const { status, body } = await send(new Request(`https://${ROUTE_HOST}/hop`));
    expect(status).toBe(502);
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(body).not.toContain('SECRET');
  });

  it.each(TARGETS)('the admin create and update of %s log none of it', async (_label, target) => {
    const created = await send(
      admin('POST', `/api/routes?domain=${ROUTE_HOST}`, {
        path: '/made',
        type: 'proxy',
        target,
        acknowledgeCredentialTarget: true,
      }),
    );
    expect(withoutEcho(created.body)).not.toContain('SECRET');

    await seedRoute(proxyRoute('/kept', 'https://upstream.example.net/'), ROUTE_HOST);
    const updated = await send(
      admin('PUT', `/api/routes?path=/kept&domain=${ROUTE_HOST}`, {
        target,
        acknowledgeCredentialTarget: true,
      }),
    );
    expect(withoutEcho(updated.body)).not.toContain('SECRET');
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it.each(TARGETS)(
    'previews of %s, and of a route stored with it, quote none of it',
    async (_label, target) => {
      await seedRoute(proxyRoute('/svc', target), ROUTE_HOST);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const direct = await send(admin('GET', `/api/metadata/og?url=${encodeURIComponent(target)}`));
      expect(direct.status).toBe(403);
      expect(direct.body).not.toContain('SECRET');

      const own = await send(
        admin('GET', `/api/metadata/og?url=${encodeURIComponent(`https://${ROUTE_HOST}/svc`)}`),
      );
      expect(own.body).not.toContain('SECRET');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(lines.join('\n')).not.toContain('SECRET');
    },
  );
});
