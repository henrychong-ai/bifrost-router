/**
 * The `pnpm dev` side of the dashboard's API proxy (v1.39.0): the cross-site
 * guard runs before the key-adding proxy, and the proxy replaces a client's
 * key with the dev server's own.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEV_API_PATH,
  dashboardApiGuard,
  devApiProxy,
  isIdentityRequest,
  missingDevKeyWarning,
  setProxiedAdminKey,
} from './dev-api-proxy';
import { CROSS_SITE_REFUSAL_BODY } from './src/lib/dashboard-request';

const HOST = 'localhost:3001';
const OWN = { 'x-bifrost-dashboard': '1', host: HOST };

function proxied(headerNames: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    getHeaderNames: () => headerNames,
    removeHeader: (name: string) => calls.push(`remove ${name}`),
    setHeader: (name: string, value: string) => calls.push(`set ${name}: ${value}`),
  };
}
/** The one proxy rule, and what its proxyReq hook does to a request. */
function rule(env: Record<string, string>) {
  const rules = devApiProxy(env);
  expect(Object.keys(rules)).toEqual([DEV_API_PATH.source]);
  const options = rules[DEV_API_PATH.source];
  if (options === undefined || typeof options === 'string') throw new Error('no proxy rule');
  const handlers: Array<(proxyReq: unknown) => void> = [];
  options.configure?.(
    {
      on: (_event: string, handler: (proxyReq: unknown) => void) => handlers.push(handler),
    } as never,
    options,
  );
  const calls: string[] = [];
  for (const handler of handlers) {
    handler({
      getHeaderNames: () => ['accept', 'tailscale-user-login', 'x-bifrost-dashboard'],
      removeHeader: (name: string) => calls.push(`remove ${name}`),
      setHeader: (name: string, value: string) => calls.push(`set ${name}: ${value}`),
    });
  }
  return { options, calls };
}

/** A fake Node response that records what the guard wrote. */
function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    end(body: string) {
      res.body = body;
    },
  };
  return { res, headers };
}

describe('dashboardApiGuard (pnpm dev)', () => {
  it('answers a cross-site /api request 403 itself and never calls the proxy', () => {
    for (const url of ['/api/routes', '/api/', '/api/?x=1', '/api/storage/b/upload']) {
      const { res, headers } = fakeResponse();
      const next = vi.fn<() => void>();
      dashboardApiGuard()(
        { url, headers: { host: HOST, origin: 'https://evil.example' } },
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(res.body ?? '')).toEqual({
        success: false,
        error: 'CROSS_SITE_REQUEST',
        message: 'The dashboard API answers only the dashboard itself.',
      });
      expect(res.body).toBe(CROSS_SITE_REFUSAL_BODY);
    }
  });

  it('lets the dashboard’s own /api requests and every other path through', () => {
    for (const [url, headers] of [
      ['/api/routes?domain=example.com', OWN],
      ['/', { host: HOST }],
      ['/apix', { host: HOST }],
      // Bare /api is not proxied, so it needs no guard
      ['/api', { host: HOST }],
      ['/api?x=1', { host: HOST }],
      ['/assets/index.js', { host: HOST, 'sec-fetch-site': 'cross-site' }],
    ] as const) {
      const { res } = fakeResponse();
      const next = vi.fn<() => void>();
      dashboardApiGuard()({ url, headers }, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.statusCode).toBe(200);
    }
  });

  it('guards exactly the paths the dev proxy forwards', () => {
    const guarded = ['/api', '/api/', '/api/routes', '/api?x', '/apix', '/ap', '/', '/x/api', ''];
    expect(guarded.filter(path => DEV_API_PATH.test(path))).toEqual(['/api/', '/api/routes']);
  });
});

describe('setProxiedAdminKey (pnpm dev)', () => {
  it('replaces a client key with the dev server’s own', () => {
    const request = proxied();
    setProxiedAdminKey(request, 'dev-key');
    expect(request.calls).toEqual([
      'remove x-admin-key',
      'remove authorization',
      'remove cookie',
      'remove proxy-authorization',
      'remove cf-access-jwt-assertion',
      'remove x-forwarded-access-token',
      'set X-Admin-Key: dev-key',
    ]);
  });

  it('drops a client key when the dev server has none', () => {
    for (const key of [undefined, '']) {
      const request = proxied();
      setProxiedAdminKey(request, key);
      expect(request.calls).toEqual([
        'remove x-admin-key',
        'remove authorization',
        'remove cookie',
        'remove proxy-authorization',
        'remove cf-access-jwt-assertion',
        'remove x-forwarded-access-token',
      ]);
    }
  });

  // As the plain image's nginx: no client identity reaches the Worker's audit
  // rows, and no X-Bifrost-* header goes on
  it('drops every client Tailscale-User-* and X-Bifrost-* header, in any case', () => {
    const request = proxied([
      'accept',
      'content-type',
      'tailscale-user-login',
      'Tailscale-User-Name',
      'tailscale-user-profile-pic',
      'x-bifrost-dashboard',
      'X-Bifrost-Anything',
      'x-bifrostish',
      'tailscale-other',
    ]);
    setProxiedAdminKey(request, 'dev-key');
    expect(request.calls).toEqual([
      'remove tailscale-user-login',
      'remove Tailscale-User-Name',
      'remove tailscale-user-profile-pic',
      'remove x-bifrost-dashboard',
      'remove X-Bifrost-Anything',
      'remove x-admin-key',
      'remove authorization',
      'remove cookie',
      'remove proxy-authorization',
      'remove cf-access-jwt-assertion',
      'remove x-forwarded-access-token',
      'set X-Admin-Key: dev-key',
    ]);
  });

  it('removes them from a real Node request', async () => {
    const { ClientRequest } = await import('node:http');
    const request = new ClientRequest({
      host: '127.0.0.1',
      port: 9,
      // Never connects: the headers are all this test reads
      createConnection: () => null,
    });
    request.setHeader('Tailscale-User-Login', 'forged@example.com');
    request.setHeader('X-Bifrost-Dashboard', '1');
    request.setHeader('X-Admin-Key', 'client-key');
    request.setHeader('Authorization', 'Bearer client-key');
    request.setHeader('Cookie', '_oauth2_proxy=session');
    request.setHeader('Cf-Access-Jwt-Assertion', 'jwt');
    request.setHeader('X-Forwarded-Access-Token', 'token');
    request.setHeader('Accept', 'application/json');
    setProxiedAdminKey(request, 'dev-key');
    expect(new Set(request.getHeaderNames())).toEqual(new Set(['accept', 'host', 'x-admin-key']));
    expect(request.getHeader('x-admin-key')).toBe('dev-key');
    request.destroy();
  });
});

describe('devApiProxy (pnpm dev)', () => {
  it('proxies to DASHBOARD_DEV_API_URL with DASHBOARD_DEV_ADMIN_API_KEY', () => {
    const { options, calls } = rule({
      DASHBOARD_DEV_API_URL: 'https://bifrost.example.com',
      DASHBOARD_DEV_ADMIN_API_KEY: 'dev-key',
    });
    expect(options.target).toBe('https://bifrost.example.com');
    expect(options.changeOrigin).toBe(true);
    expect(calls).toEqual([
      'remove tailscale-user-login',
      'remove x-bifrost-dashboard',
      'remove x-admin-key',
      'remove authorization',
      'remove cookie',
      'remove proxy-authorization',
      'remove cf-access-jwt-assertion',
      'remove x-forwarded-access-token',
      'set X-Admin-Key: dev-key',
    ]);
  });

  it('defaults to the local Worker and never reads a VITE_ key', () => {
    const { options, calls } = rule({ VITE_ADMIN_API_KEY: 'browser-visible', VITE_API_URL: 'x' });
    expect(options.target).toBe('http://localhost:8787');
    expect(calls).toEqual([
      'remove tailscale-user-login',
      'remove x-bifrost-dashboard',
      'remove x-admin-key',
      'remove authorization',
      'remove cookie',
      'remove proxy-authorization',
      'remove cf-access-jwt-assertion',
      'remove x-forwarded-access-token',
    ]);
  });
});

describe('isIdentityRequest (pnpm dev)', () => {
  it('matches the identity pathname exactly, whatever the query', () => {
    for (const url of ['/api/tailscale/identity', '/api/tailscale/identity?x=1']) {
      expect(isIdentityRequest(url)).toBe(true);
    }
    for (const url of [
      '/api/tailscale/identity/x',
      '/api/tailscale/identityx',
      '/api/tailscale/identity/',
      '/api/tailscale',
      '/x/api/tailscale/identity',
      '',
      undefined,
    ]) {
      expect({ url, identity: isIdentityRequest(url) }).toEqual({ url, identity: false });
    }
  });
});

describe('missingDevKeyWarning (pnpm dev)', () => {
  it('warns without a dev key, never naming a key', () => {
    for (const env of [{}, { DASHBOARD_DEV_ADMIN_API_KEY: '' }, { VITE_ADMIN_API_KEY: 'k' }]) {
      expect(missingDevKeyWarning(env)).toMatch(/DASHBOARD_DEV_ADMIN_API_KEY is not set/);
    }
    expect(missingDevKeyWarning({ DASHBOARD_DEV_ADMIN_API_KEY: 'dev-key' })).toBeNull();
  });
});
