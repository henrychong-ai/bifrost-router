import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { getRoute } from '../../src/kv/routes';
import { clearAllRoutes, seedRoute } from '../helpers';

/**
 * The route-target credential guard.
 *
 * A configured target is not request data: it is stored in KV, copied into the
 * click and proxy analytics, written to the request log, and handed to every
 * visitor who opens the short link. A write that leaves such a target ENABLED
 * is refused unless the operator acknowledges it, and the acknowledgement is
 * request-only — it must never reach KV.
 */
describe('route target credential guard', () => {
  const validApiKey = 'test-api-key-12345';
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };
  const app = new Hono<AppEnv>().route('/api', adminRoutes);

  beforeEach(async () => {
    await clearAllRoutes();
  });

  const call = (path: string, method: string, body?: unknown) =>
    app.fetch(
      new Request(`http://example.com${path}`, {
        method,
        headers: { 'X-Admin-Key': validApiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      testEnv,
    );

  const redirectRoute = (overrides: Record<string, unknown> = {}) => ({
    path: '/cred',
    type: 'redirect',
    target: 'https://app.example/verify?token=LIVE-GRANT',
    statusCode: 302,
    ...overrides,
  });

  describe('create', () => {
    it('refuses a credential-bearing target and names the parameters only', async () => {
      const response = await call('/api/routes?domain=links.example.com', 'POST', redirectRoute());

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('ROUTE_TARGET_CREDENTIAL');
      expect(data.details.parameters).toEqual(['token']);
      // The refusal must never echo the value back.
      expect(JSON.stringify(data)).not.toContain('LIVE-GRANT');
      expect(await getRoute(env.ROUTES, 'links.example.com', '/cred')).toBeNull();
    });

    it('errs WIDE: an ambiguous name is flagged whatever its value', async () => {
      const response = await call(
        '/api/routes?domain=links.example.com',
        'POST',
        redirectRoute({ target: 'https://app.example/landing?code=SUMMER25' }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.details.parameters).toEqual(['code']);
    });

    it('scans the FRAGMENT — a browser keeps it, unlike a referrer', async () => {
      const response = await call(
        '/api/routes?domain=links.example.com',
        'POST',
        redirectRoute({ target: 'https://app.example/#/reset?token=LIVE' }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.details.parameters).toEqual(['token']);
    });

    it('proceeds on an acknowledged write, and never stores the flag', async () => {
      const response = await call('/api/routes?domain=links.example.com', 'POST', {
        ...redirectRoute(),
        acknowledgeCredentialTarget: true,
      });

      expect(response.status).toBe(201);
      const stored = await getRoute(env.ROUTES, 'links.example.com', '/cred');
      expect(stored?.target).toBe('https://app.example/verify?token=LIVE-GRANT');
      expect(stored).not.toHaveProperty('acknowledgeCredentialTarget');
      const raw = await env.ROUTES.get('links.example.com:/cred');
      expect(raw).not.toContain('acknowledgeCredentialTarget');
    });

    it('does not guard a route created already DISABLED', async () => {
      const response = await call(
        '/api/routes?domain=links.example.com',
        'POST',
        redirectRoute({ enabled: false }),
      );

      expect(response.status).toBe(201);
    });

    it('does not guard an r2 target — object keys are not URLs', async () => {
      const response = await call('/api/routes?domain=links.example.com', 'POST', {
        path: '/cred',
        type: 'r2',
        target: 'reports/q3?token=not-a-url',
      });

      expect(response.status).toBe(201);
    });

    it('refuses a target carrying a control character at the schema', async () => {
      const response = await call(
        '/api/routes?domain=links.example.com',
        'POST',
        redirectRoute({ target: 'https://app.example/?to\tken=LIVE' }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      // Rejected before the guard: the URL parser would strip the tab and serve
      // `?token=LIVE`, so the two must never be able to disagree.
      expect(data.error).toBe('Validation failed');
    });

    it('refuses a path that cannot round-trip through normalisation', async () => {
      for (const path of ['/p%3Fx', '/p%253Fx']) {
        const response = await call(
          '/api/routes?domain=links.example.com',
          'POST',
          redirectRoute({ path, target: 'https://app.example/landing' }),
        );
        expect(response.status).toBe(400);
      }
    });
  });

  describe('update and re-enable', () => {
    beforeEach(async () => {
      await seedRoute(
        {
          path: '/stored',
          type: 'redirect',
          target: 'https://app.example/verify?token=LIVE-GRANT',
          statusCode: 302,
          enabled: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        'links.example.com',
      );
    });

    it('refuses a re-enable of a stored credential target', async () => {
      const response = await call('/api/routes?path=/stored&domain=links.example.com', 'PUT', {
        enabled: true,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('ROUTE_TARGET_CREDENTIAL');
      expect(data.details.parameters).toEqual(['token']);
      const stored = await getRoute(env.ROUTES, 'links.example.com', '/stored');
      expect(stored?.enabled).toBe(false);
    });

    it('never refuses a DISABLE — that is the action that reduces exposure', async () => {
      await call('/api/routes?path=/stored&domain=links.example.com', 'PUT', {
        enabled: true,
        acknowledgeCredentialTarget: true,
      });

      const response = await call('/api/routes?path=/stored&domain=links.example.com', 'PUT', {
        enabled: false,
      });

      expect(response.status).toBe(200);
    });

    it('accepts the acknowledged re-enable and keeps the flag out of KV', async () => {
      const response = await call('/api/routes?path=/stored&domain=links.example.com', 'PUT', {
        enabled: true,
        acknowledgeCredentialTarget: true,
      });

      expect(response.status).toBe(200);
      const raw = await env.ROUTES.get('links.example.com:/stored');
      expect(raw).not.toContain('acknowledgeCredentialTarget');
    });
  });

  describe('seed', () => {
    it('refuses the batch and names the offending paths', async () => {
      const response = await call('/api/routes/seed?domain=links.example.com', 'POST', {
        routes: [
          { path: '/clean', type: 'redirect', target: 'https://app.example/ok' },
          { path: '/dirty', type: 'redirect', target: 'https://app.example/cb?token=LIVE' },
        ],
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('ROUTE_TARGET_CREDENTIAL');
      expect(data.details.parameters).toEqual(['token']);
      expect(data.details.paths).toEqual(['/dirty']);
      // Nothing is written when the batch is refused.
      expect(await getRoute(env.ROUTES, 'links.example.com', '/clean')).toBeNull();
    });

    it('reports malformed routes BEFORE the acknowledgement loop', async () => {
      const response = await call('/api/routes/seed?domain=links.example.com', 'POST', {
        routes: [
          { path: 'no-leading-slash', type: 'redirect', target: 'https://app.example/ok' },
          { path: '/dirty', type: 'redirect', target: 'https://app.example/cb?token=LIVE' },
        ],
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Some routes failed validation');
    });

    it('seeds the batch once acknowledged', async () => {
      const response = await call('/api/routes/seed?domain=links.example.com', 'POST', {
        routes: [{ path: '/dirty', type: 'redirect', target: 'https://app.example/cb?token=LIVE' }],
        acknowledgeCredentialTarget: true,
      });

      expect(response.status).toBe(200);
      expect(await getRoute(env.ROUTES, 'links.example.com', '/dirty')).not.toBeNull();
    });
  });

  describe('transfer', () => {
    beforeEach(async () => {
      await seedRoute(
        {
          path: '/moving',
          type: 'redirect',
          target: 'https://app.example/cb?token=LIVE',
          statusCode: 302,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        'links.example.com',
      );
    });

    it('needs its own acknowledgement — a new host is a new audience', async () => {
      const response = await call('/api/routes/transfer', 'POST', {
        path: '/moving',
        fromDomain: 'links.example.com',
        toDomain: 'secondary.example.net',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('ROUTE_TARGET_CREDENTIAL');
      // The source route is untouched by a refusal.
      expect(await getRoute(env.ROUTES, 'links.example.com', '/moving')).not.toBeNull();
    });

    it('proceeds once acknowledged', async () => {
      const response = await call('/api/routes/transfer', 'POST', {
        path: '/moving',
        fromDomain: 'links.example.com',
        toDomain: 'secondary.example.net',
        acknowledgeCredentialTarget: true,
      });

      expect(response.status).toBe(200);
      expect(await getRoute(env.ROUTES, 'secondary.example.net', '/moving')).not.toBeNull();
    });
  });

  describe('migrate', () => {
    it('validates both paths with the full round-trip schema', async () => {
      await seedRoute(
        {
          path: '/old',
          type: 'redirect',
          target: 'https://app.example/ok',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        'links.example.com',
      );

      const response = await call(
        '/api/routes/migrate?oldPath=/old&newPath=/p%3Fx&domain=links.example.com',
        'POST',
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/must not contain \? or #/);
      // The original route is untouched.
      expect(await getRoute(env.ROUTES, 'links.example.com', '/old')).not.toBeNull();
    });
  });
});
