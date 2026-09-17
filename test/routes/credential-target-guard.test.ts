import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes, credentialTargetParameters } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { getRoute } from '../../src/kv/routes';
import {
  clearAllRoutes,
  createAuditLogsTable,
  createSettlingExecutionContext,
  seedRoute,
} from '../helpers';

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

/**
 * The guard must read the SAME key the mutation writes.
 *
 * `normalizePath()` lowercases, collapses `//`, strips a trailing slash and
 * percent-decodes, and every mutation applies it. A pre-read that builds its
 * key from the RAW path therefore MISSES on any alias of a stored path — and a
 * miss is silent: the guard sees no stored target, raises no refusal, and the
 * mutation then normalises and writes the record the guard never examined.
 *
 * Every alias below passes `RoutePathSchema`, so none of them is refused
 * earlier.
 */
describe('admin pre-reads resolve the stored record through an alias', () => {
  const validApiKey = 'test-api-key-12345';
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };
  const app = new Hono<AppEnv>().route('/api', adminRoutes);
  const domain = 'links.example.com';

  /** Aliases of `/promo` that normalise onto it but differ byte-for-byte. */
  const ALIASES = ['/Promo', '/promo/', '//promo', '/pro%6do'];

  const call = (path: string, method: string, body?: unknown) =>
    app.fetch(
      new Request(`http://example.com${path}`, {
        method,
        headers: { 'X-Admin-Key': validApiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      testEnv,
    );

  beforeEach(async () => {
    await clearAllRoutes();
  });

  async function seedDisabledCredentialRoute(): Promise<void> {
    await seedRoute(
      {
        path: '/promo',
        type: 'redirect',
        target: 'https://app.example/verify?token=LIVE-GRANT',
        statusCode: 302,
        enabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );
  }

  it.each(ALIASES)('refuses a re-enable requested through %s', async alias => {
    await seedDisabledCredentialRoute();

    const response = await call(
      `/api/routes?path=${encodeURIComponent(alias)}&domain=${domain}`,
      'PUT',
      { enabled: true },
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('ROUTE_TARGET_CREDENTIAL');
    // The route stays disabled — the mutation must not have run.
    const stored = await getRoute(env.ROUTES, domain, '/promo');
    expect(stored?.enabled).toBe(false);
  });

  it.each(ALIASES)('refuses a transfer requested through %s', async alias => {
    await seedRoute(
      {
        path: '/promo',
        type: 'redirect',
        target: 'https://app.example/verify?token=LIVE-GRANT',
        statusCode: 302,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );

    const response = await call('/api/routes/transfer', 'POST', {
      path: alias,
      fromDomain: domain,
      toDomain: 'secondary.example.net',
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('ROUTE_TARGET_CREDENTIAL');
    // Both domains are unchanged by a refusal.
    expect(await getRoute(env.ROUTES, domain, '/promo')).not.toBeNull();
    expect(await getRoute(env.ROUTES, 'secondary.example.net', '/promo')).toBeNull();
  });

  it.each(ALIASES)('returns 409 rather than overwriting through %s', async alias => {
    await seedRoute(
      {
        path: '/promo',
        type: 'redirect',
        target: 'https://app.example/original',
        statusCode: 302,
        createdAt: 111,
        updatedAt: 111,
      },
      domain,
    );

    const response = await call(`/api/routes?domain=${domain}`, 'POST', {
      path: alias,
      type: 'redirect',
      target: 'https://app.example/overwritten',
    });

    expect(response.status).toBe(409);
    // The stored record is untouched, timestamps included.
    const stored = await getRoute(env.ROUTES, domain, '/promo');
    expect(stored?.target).toBe('https://app.example/original');
    expect(stored?.createdAt).toBe(111);
  });

  it('audits the real before-state when a delete is requested through an alias', async () => {
    await seedRoute(
      {
        path: '/promo',
        type: 'redirect',
        target: 'https://app.example/original',
        statusCode: 302,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );

    const response = await call(`/api/routes?path=/Promo&domain=${domain}`, 'DELETE');

    expect(response.status).toBe(200);
    expect(await getRoute(env.ROUTES, domain, '/promo')).toBeNull();
  });

  it('skips an existing route when seed quotes an alias', async () => {
    await seedRoute(
      {
        path: '/promo',
        type: 'redirect',
        target: 'https://app.example/original',
        statusCode: 302,
        createdAt: 222,
        updatedAt: 222,
      },
      domain,
    );

    const response = await call(`/api/routes/seed?domain=${domain}`, 'POST', {
      routes: [{ path: '/Promo', type: 'redirect', target: 'https://app.example/overwritten' }],
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data).toMatchObject({ created: 0, skipped: 1 });
    const stored = await getRoute(env.ROUTES, domain, '/promo');
    expect(stored?.target).toBe('https://app.example/original');
    expect(stored?.createdAt).toBe(222);
  });
});

/**
 * `credentialTargetParameters()` directly.
 *
 * The guard's two scans — the control-stripped raw target and the union with
 * what the URL parser actually produced — are otherwise only reached through
 * the HTTP handlers, where the schema rejects a control character before the
 * guard ever runs. A route STORED before that schema existed still reaches the
 * guard on a re-enable or a transfer, so both scans need direct cover.
 */
describe('credentialTargetParameters', () => {
  it('names the credential parameters of an ordinary target', () => {
    expect(
      credentialTargetParameters({
        type: 'redirect',
        target: 'https://app.example/cb?token=LIVE&utm_source=x',
      }),
    ).toEqual(['token']);
  });

  it.each([
    ['tab', '\t'],
    ['LF', '\n'],
    ['CR', '\r'],
  ])('sees through a %s hidden in a STORED target, which the parser strips', (_label, control) => {
    // The schema refuses these on a write, but a route stored before that check
    // still reaches the guard. Scanning the raw string alone would read
    // `to<CTRL>ken` and pass it; the parser then serves `?token=LIVE`.
    expect(
      credentialTargetParameters({
        type: 'redirect',
        target: `https://app.example/?to${control}ken=LIVE`,
      }),
    ).toEqual(['token']);
  });

  it('unions the raw scan with the parsed URL rather than replacing it', () => {
    // The fragment survives parsing and the query is reported once, not twice.
    expect(
      credentialTargetParameters({
        type: 'redirect',
        target: 'https://app.example/cb?token=LIVE#access_token=SECOND',
      }),
    ).toEqual(['token', 'access_token']);
  });

  it('returns nothing for the cases the guard deliberately skips', () => {
    // Disabled: refusing a DISABLE would block the action that reduces exposure.
    expect(
      credentialTargetParameters({
        type: 'redirect',
        target: 'https://app.example/cb?token=LIVE',
        enabled: false,
      }),
    ).toEqual([]);
    // r2 object keys are not URLs.
    expect(credentialTargetParameters({ type: 'r2', target: 'reports/q3?token=x' })).toEqual([]);
    // No target at all.
    expect(credentialTargetParameters({ type: 'redirect' })).toEqual([]);
    // A relative target is not an absolute URL — the raw scan is the whole answer.
    expect(credentialTargetParameters({ type: 'redirect', target: '/local?token=LIVE' })).toEqual([
      'token',
    ]);
  });
});

/**
 * An acknowledged write records the parameter NAMES in its audit row, and only
 * for the records it actually wrote.
 */
describe('audit rows record credentialTargetAcknowledged', () => {
  const validApiKey = 'test-api-key-12345';
  const domain = 'links.example.com';
  const app = new Hono<AppEnv>().route('/api', adminRoutes);

  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
    await env.DB.prepare('DELETE FROM audit_logs').run();
  });

  /** Drive the handler with a settling context so the waitUntil audit write lands. */
  async function callWithAudit(path: string, method: string, body?: unknown): Promise<Response> {
    const { ctx, settled } = createSettlingExecutionContext();
    const response = await app.fetch(
      new Request(`http://example.com${path}`, {
        method,
        headers: { 'X-Admin-Key': validApiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { ...env, ADMIN_API_DOMAIN: 'example.com' },
      ctx,
    );
    await settled();
    return response;
  }

  async function auditDetails(action: string): Promise<Record<string, unknown>> {
    const row = await env.DB.prepare(
      'SELECT details FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1',
    )
      .bind(action)
      .first<{ details: string }>();
    return JSON.parse(row?.details ?? '{}');
  }

  const credentialTarget = 'https://app.example/cb?token=LIVE';

  it('records the names on an acknowledged create, and nothing on a clean one', async () => {
    expect(
      (
        await callWithAudit(`/api/routes?domain=${domain}`, 'POST', {
          path: '/ack-create',
          type: 'redirect',
          target: credentialTarget,
          acknowledgeCredentialTarget: true,
        })
      ).status,
    ).toBe(201);
    expect(await auditDetails('create')).toMatchObject({
      credentialTargetAcknowledged: ['token'],
    });
    // The acknowledgement carries NAMES only. (The `route` snapshot beside it
    // does hold the target — that is the record the operator just created, and
    // recording it is the point of a create audit row. The names-never-values
    // guarantee is about the acknowledgement field and the refusal response.)
    expect(
      JSON.stringify((await auditDetails('create')).credentialTargetAcknowledged),
    ).not.toContain('LIVE');

    await callWithAudit(`/api/routes?domain=${domain}`, 'POST', {
      path: '/clean-create',
      type: 'redirect',
      target: 'https://app.example/ok',
    });
    expect(await auditDetails('create')).not.toHaveProperty('credentialTargetAcknowledged');
  });

  it('records the names on an acknowledged re-enable, and keeps it a toggle', async () => {
    await seedRoute(
      {
        path: '/ack-toggle',
        type: 'redirect',
        target: credentialTarget,
        enabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );

    expect(
      (
        await callWithAudit(`/api/routes?path=/ack-toggle&domain=${domain}`, 'PUT', {
          enabled: true,
          acknowledgeCredentialTarget: true,
        })
      ).status,
    ).toBe(200);

    // The acknowledgement is a request-only flag, not an edited field, so the
    // action stays 'toggle' rather than becoming 'update'.
    expect(await auditDetails('toggle')).toMatchObject({
      enabled: true,
      credentialTargetAcknowledged: ['token'],
    });
  });

  it('records the names on an acknowledged transfer', async () => {
    await seedRoute(
      {
        path: '/ack-transfer',
        type: 'redirect',
        target: credentialTarget,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );

    expect(
      (
        await callWithAudit('/api/routes/transfer', 'POST', {
          path: '/ack-transfer',
          fromDomain: domain,
          toDomain: 'secondary.example.net',
          acknowledgeCredentialTarget: true,
        })
      ).status,
    ).toBe(200);
    expect(await auditDetails('transfer')).toMatchObject({
      credentialTargetAcknowledged: ['token'],
    });
  });

  it('records seed names only for the routes it actually CREATED', async () => {
    // The credential-bearing path already exists, so seed SKIPS it. Recording
    // an override against a record this call never wrote would be a false entry.
    await seedRoute(
      {
        path: '/already-there',
        type: 'redirect',
        target: credentialTarget,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );

    const response = await callWithAudit(`/api/routes/seed?domain=${domain}`, 'POST', {
      routes: [
        { path: '/already-there', type: 'redirect', target: credentialTarget },
        { path: '/fresh', type: 'redirect', target: 'https://app.example/ok' },
      ],
      acknowledgeCredentialTarget: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { created: 1, skipped: 1 } });
    expect(await auditDetails('seed')).not.toHaveProperty('credentialTargetAcknowledged');
  });

  it('records seed names for a credential route it DID create', async () => {
    const response = await callWithAudit(`/api/routes/seed?domain=${domain}`, 'POST', {
      routes: [{ path: '/seeded-cred', type: 'redirect', target: credentialTarget }],
      acknowledgeCredentialTarget: true,
    });

    expect(response.status).toBe(200);
    expect(await auditDetails('seed')).toMatchObject({
      credentialTargetAcknowledged: ['token'],
    });
  });
});

/**
 * The write paths that refuse a path the route-path schema rejects. Transfer was
 * the last one checking only the leading slash, so a legacy non-round-tripping
 * key could still be re-published on a second domain.
 */
describe('route-path schema on every write path', () => {
  const validApiKey = 'test-api-key-12345';
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };
  const app = new Hono<AppEnv>().route('/api', adminRoutes);
  const domain = 'links.example.com';

  /** `?`, `#`, a double-encoded `%`, and each control character the parser strips. */
  // …including the ENCODED control characters, which normalisation would
  // decode into the real thing (`/p%09x` becomes a tab).
  const BAD_PATHS = [
    '/p%3Fx',
    '/p#x',
    '/p%253Fx',
    '/p\tx',
    '/p\nx',
    '/p\u007fx',
    '/p%09x',
    '/p%0Ax',
    '/p%7Fx',
  ];

  const call = (path: string, method: string, body?: unknown) =>
    app.fetch(
      new Request(`http://example.com${path}`, {
        method,
        headers: { 'X-Admin-Key': validApiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      testEnv,
    );

  beforeEach(async () => {
    await clearAllRoutes();
  });

  it.each(BAD_PATHS)('create refuses %j', async path => {
    const response = await call(`/api/routes?domain=${domain}`, 'POST', {
      path,
      type: 'redirect',
      target: 'https://app.example/ok',
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/must not contain/);
  });

  it.each(BAD_PATHS)('transfer refuses %j and leaves both domains untouched', async path => {
    const response = await call('/api/routes/transfer', 'POST', {
      path,
      fromDomain: domain,
      toDomain: 'secondary.example.net',
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/must not contain/);
    const remaining = await env.ROUTES.list({ prefix: 'secondary.example.net:' });
    expect(remaining.keys).toHaveLength(0);
  });

  it.each(BAD_PATHS)('migrate refuses %j as the new path', async path => {
    await seedRoute(
      {
        path: '/old',
        type: 'redirect',
        target: 'https://app.example/ok',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      domain,
    );

    const response = await call(
      `/api/routes/migrate?oldPath=/old&newPath=${encodeURIComponent(path)}&domain=${domain}`,
      'POST',
    );

    expect(response.status).toBe(400);
    expect(await getRoute(env.ROUTES, domain, '/old')).not.toBeNull();
  });
});
