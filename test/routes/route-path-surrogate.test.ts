/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */
/**
 * A route path holding an unpaired UTF-16 surrogate. A NEW path is refused
 * (create, seed, a QR code's linked route): it has no UTF-8 form, so its key,
 * short URL and linked code would hold U+FFFD. A path that names an EXISTING
 * route keeps the rules it was stored under, so a route stored before the
 * rule stays reachable through the operations that carry the path in the
 * query string (a query string carries a lone surrogate as U+FFFD, which
 * reaches the key such a route is stored under). Transfer carries the path in
 * its JSON body, so its lookup would use the raw key: it is refused as a 400
 * instead, and its U+FFFD form reaches the same key. Migrate's new path is a
 * query parameter too; the MCP `migrate_route` schema refuses one
 * (`shared/src/schemas.test.ts`).
 *
 * How such a route is stored: the local test runtime's KV refuses a key
 * holding a lone surrogate, so the stored route modelled is a record whose
 * `path` holds the surrogate under the key with U+FFFD in its place.
 */
import { env } from 'cloudflare:test';
import { ROUTE_PATH_MALFORMED_MESSAGE } from '@bifrost/shared';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import migration0013 from '../../drizzle/0013_qr_recent.sql?raw';
import { routeKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { clearAllRoutes, createAuditLogsTable, createSettlingExecutionContext } from '../helpers';

const DOMAIN = 'links.example.com';
const OTHER = 'example.com';
const BASE = 'https://example.com';
const headers = { 'X-Admin-Key': 'test-api-key-12345', 'Content-Type': 'application/json' };
const app = new Hono<AppEnv>().route('/api', adminRoutes);
const LONE = '/a\ud83d';

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, ADMIN_API_DOMAIN: OTHER },
    ctx,
  );
  await settled();
  return response;
}

/** `path` as a query-string value, as a client writes it (a lone surrogate as U+FFFD). */
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** The KV key of `path` on `domain`, each unpaired surrogate held as U+FFFD. */
const key = (path: string, domain = DOMAIN) =>
  routeKey(domain, path.replace(/[\ud800-\udfff]/g, '\uFFFD'));

/** A redirect route stored as an earlier release wrote it, at `path` on DOMAIN. */
async function storeRoute(path: string): Promise<void> {
  await env.ROUTES.put(
    key(path),
    JSON.stringify({
      path,
      type: 'redirect',
      target: 'https://example.com/landing',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

/** The record stored at `path` on `domain`, parsed, or null. */
async function stored(path: string, domain = DOMAIN): Promise<Record<string, unknown> | null> {
  const text = await env.ROUTES.get(key(path, domain));
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

describe('a route path holding an unpaired surrogate', () => {
  beforeAll(async () => {
    const statements = migration0013
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map(statement => statement.trim())
      .filter(statement => statement.length > 0);
    for (const statement of statements) await env.DB.prepare(statement).run();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
  });

  describe('a stored route stays reachable through the operations that name it', () => {
    beforeEach(async () => {
      await storeRoute(LONE);
    });

    it('is stored under the key with U+FFFD in place of the surrogate', async () => {
      expect((await stored(LONE))?.['path']).toBe(LONE);
    });

    it('GET reads it', async () => {
      const response = await call('GET', `/api/routes?${query({ path: LONE, domain: DOMAIN })}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('https://example.com/landing');
    });

    it('PUT updates it and disables it', async () => {
      const at = `/api/routes?${query({ path: LONE, domain: DOMAIN })}`;
      expect((await call('PUT', at, { target: 'https://example.com/updated' })).status).toBe(200);
      expect((await stored(LONE))?.['target']).toBe('https://example.com/updated');
      expect((await call('PUT', at, { enabled: false })).status).toBe(200);
      expect((await stored(LONE))?.['enabled']).toBe(false);
    });

    it('migrate moves it away to a new path', async () => {
      const response = await call(
        'POST',
        `/api/routes/migrate?${query({ oldPath: LONE, newPath: '/moved', domain: DOMAIN })}`,
      );
      expect(response.status).toBe(200);
      expect(await stored(LONE)).toBeNull();
      expect((await stored('/moved'))?.['target']).toBe('https://example.com/landing');
    });

    it('DELETE deletes it', async () => {
      const response = await call('DELETE', `/api/routes?${query({ path: LONE, domain: DOMAIN })}`);
      expect(response.status).toBe(200);
      expect(await stored(LONE)).toBeNull();
    });
  });

  describe('a new path is refused', () => {
    it('create', async () => {
      const response = await call('POST', `/api/routes?domain=${DOMAIN}`, {
        path: LONE,
        type: 'redirect',
        target: 'https://example.com/landing',
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(ROUTE_PATH_MALFORMED_MESSAGE);
      expect(await stored(LONE)).toBeNull();
      // A well-formed pair (an emoji) is an ordinary path
      const emoji = await call('POST', `/api/routes?domain=${DOMAIN}`, {
        path: '/a\u{1F600}',
        type: 'redirect',
        target: 'https://example.com/landing',
      });
      expect(emoji.status).toBe(201);
    });

    it('seed', async () => {
      const response = await call('POST', `/api/routes/seed?domain=${DOMAIN}`, {
        routes: [{ path: LONE, type: 'redirect', target: 'https://example.com/landing' }],
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(ROUTE_PATH_MALFORMED_MESSAGE);
      expect(await stored(LONE)).toBeNull();
    });

    it('transfer: the route stays where it is', async () => {
      await storeRoute(LONE);
      const response = await call('POST', '/api/routes/transfer', {
        path: LONE,
        fromDomain: DOMAIN,
        toDomain: OTHER,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(ROUTE_PATH_MALFORMED_MESSAGE);
      expect((await stored(LONE))?.['path']).toBe(LONE);
      expect(await stored(LONE, OTHER)).toBeNull();
    });

    it("a QR code's linked route", async () => {
      const response = await call('POST', `/api/qr?domain=${DOMAIN}`, {
        type: 'url',
        id: 'linked-lone',
        payload: { url: 'https://example.com/landing' },
        linkedRoute: { domain: DOMAIN, path: LONE },
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(ROUTE_PATH_MALFORMED_MESSAGE);
      expect(await env.ROUTES.get(`qr:${DOMAIN}:linked-lone`)).toBeNull();
    });
  });
});
