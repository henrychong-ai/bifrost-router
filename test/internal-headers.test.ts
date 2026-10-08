import { env } from 'cloudflare:test';
import { isInternalHeader } from '@bifrost/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { withoutInternalHeaders } from '../src/utils/internal-headers';
import { ownHostResolver } from '../src/utils/og-own-host';
import { safeServiceFetch } from '../src/utils/safe-service-fetch';
import { clearAllRoutes } from './helpers';

/**
 * This deployment's own headers (the admin key, X-Bifrost-*, Tailscale-User-*)
 * never leave it on any forwarding path (v1.39.0): the proxy handler (see
 * test/handlers/proxy.test.ts), the service-binding fallback and the own-host
 * link preview, through one shared rule.
 */
const INTERNAL = {
  'X-Admin-Key': 'admin-key-value',
  'X-Bifrost-Dashboard': '1',
  'X-Bifrost-Anything': 'x',
  'Tailscale-User-Login': 'person@example.com',
  'Tailscale-User-Name': 'A Person',
  'Tailscale-User-Profile-Pic': 'https://example.com/pic.png',
};
const INTERNAL_NAMES = Object.keys(INTERNAL).map(name => name.toLowerCase());

function capturingBinding() {
  const seen: Request[] = [];
  const fetcher = {
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response('<title>Site</title>', { headers: { 'Content-Type': 'text/html' } });
    },
  } as unknown as Fetcher;
  return { seen, fetcher };
}

describe('isInternalHeader', () => {
  it('names the admin key, X-Bifrost-* and Tailscale-User-* in any case, and nothing else', () => {
    for (const name of [
      ...Object.keys(INTERNAL),
      'X-ADMIN-KEY',
      'x-bifrost-',
      'TAILSCALE-USER-X',
    ]) {
      expect({ name, internal: isInternalHeader(name) }).toEqual({ name, internal: true });
    }
    for (const name of [
      'x-admin-keys',
      'x-admin',
      'x-bifrostx',
      'tailscale-funnel-request',
      'tailscale-user',
      'authorization',
      'cookie',
      'x-custom',
    ]) {
      expect({ name, internal: isInternalHeader(name) }).toEqual({ name, internal: false });
    }
  });

  it('withoutInternalHeaders drops an Authorization that carries the admin key', () => {
    const key = 'admin-key-value';
    for (const value of [`Bearer ${key}`, key]) {
      const kept = withoutInternalHeaders({ Authorization: value, 'X-Custom': 'a' }, key);
      expect([...kept.keys()]).toEqual(['x-custom']);
    }
    // The visitor's own credential, or any value when no key is known, stays
    for (const [value, adminKey] of [
      ['Bearer visitor-token', key],
      [`Bearer ${key}-other`, key],
      [`Basic ${key}`, key],
      [`Bearer ${key}`, undefined],
      [`Bearer ${key}`, ''],
    ] as const) {
      const kept = withoutInternalHeaders({ Authorization: value }, adminKey);
      expect({ value, kept: kept.get('authorization') }).toEqual({ value, kept: value });
    }
  });

  it('withoutInternalHeaders keeps every other header, repeated values included', () => {
    const headers = new Headers({ ...INTERNAL, Authorization: 'Bearer t', 'X-Custom': 'a' });
    headers.append('X-Custom', 'b');
    const kept = withoutInternalHeaders(headers);
    expect([...kept.keys()].toSorted()).toEqual(['authorization', 'x-custom']);
    expect(kept.get('x-custom')).toBe('a, b');
    // The input is untouched
    expect(headers.get('x-admin-key')).toBe('admin-key-value');
  });
});

describe('the service-binding fallback', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await clearAllRoutes();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });

  it('safeServiceFetch forwards the method, body and other headers, never internal ones', async () => {
    const { seen, fetcher } = capturingBinding();
    await safeServiceFetch(
      fetcher,
      new Request('https://example.com/form?x=1', {
        method: 'POST',
        headers: { ...INTERNAL, 'Content-Type': 'text/plain', Cookie: 'site=1' },
        body: 'payload',
      }),
      { hostname: 'example.com' },
    );
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://example.com/form?x=1');
    expect(await request?.text()).toBe('payload');
    expect(request?.headers.get('cookie')).toBe('site=1');
    expect(request?.headers.get('content-type')).toBe('text/plain');
    for (const name of INTERNAL_NAMES) {
      expect({ name, value: request?.headers.get(name) }).toEqual({ name, value: null });
    }
  });

  it('a visitor request the Worker hands to the binding carries no internal header', async () => {
    const { seen, fetcher } = capturingBinding();
    const testEnv = { ...env, EXAMPLE_SITE: fetcher } as unknown as Bindings;
    const response = await worker.fetch(
      new Request('https://example.com/about', {
        headers: { ...INTERNAL, Authorization: `Bearer ${String(env.ADMIN_API_KEY)}` },
      }),
      testEnv,
      { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    for (const name of [...INTERNAL_NAMES, 'authorization']) {
      expect({ name, value: seen[0]?.headers.get(name) }).toEqual({ name, value: null });
    }
    // A visitor's own credential still reaches the site
    const own = await worker.fetch(
      new Request('https://example.com/about', { headers: { Authorization: 'Bearer site' } }),
      testEnv,
      { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
    );
    expect(own.status).toBe(200);
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer site');
  });

  it('an own-host preview hands the binding no internal header', async () => {
    const { seen, fetcher } = capturingBinding();
    const testEnv = { ...env, EXAMPLE_SITE: fetcher } as unknown as Bindings;
    const answer = await ownHostResolver(testEnv).resolve(
      new URL('https://example.com/about'),
      new AbortController().signal,
    );
    expect(answer.kind).toBe('response');
    expect(seen).toHaveLength(1);
    expect([...(seen[0]?.headers.keys() ?? [])].filter(isInternalHeader)).toEqual([]);
    expect(seen[0]?.headers.get('user-agent')).toContain('OpenGraph');
  });
});
