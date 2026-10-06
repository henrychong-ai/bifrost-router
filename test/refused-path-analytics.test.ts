/**
 * A request whose path the matched route refuses (a preservePath or proxy
 * remainder that cannot be aligned with the route's base, or a refused proxy
 * segment) is a 404 with no click or proxy analytics, and its unified traffic
 * event is `not_found` (v1.37.2).
 */

import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import {
  clearAllRoutes,
  createLinkClicksTable,
  createProxyRequestsTable,
  createSettlingExecutionContext,
  seedRoute,
} from './helpers';

const HOST = 'links.example.com';

const shadowEnv = {
  ...env,
  UNIFIED_TRAFFIC_MODE: 'shadow',
  UNIFIED_TRAFFIC_CUTOVER_AT: '2026-01-01T00:00:00Z',
  UNIFIED_TRAFFIC_RETENTION_DAYS: '30',
  ADMIN_API_DOMAIN: 'bifrost.example.com',
} as unknown as Bindings;

async function visit(path: string): Promise<number> {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await worker.fetch(
    new Request(`https://${HOST}${path}`, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0' },
    }),
    shadowEnv,
    ctx,
  );
  await response.body?.cancel();
  await settled();
  return response.status;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

async function eventTypes(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT event_type FROM unified_traffic_events').all<{
    event_type: string;
  }>();
  return results.map(row => row.event_type);
}

describe('analytics for a refused request path', () => {
  beforeAll(async () => {
    await createLinkClicksTable();
    await createProxyRequestsTable();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS unified_traffic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, path TEXT NOT NULL,
        event_type TEXT NOT NULL, outcome TEXT NOT NULL, response_status INTEGER NOT NULL,
        response_bytes INTEGER, cache_status TEXT, country TEXT, traffic_class TEXT NOT NULL,
        latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    for (const table of ['link_clicks', 'proxy_requests', 'unified_traffic_events']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('upstream', { status: 200 })),
    );
    await seedRoute(
      {
        path: '/zzr/a/*',
        type: 'redirect',
        target: 'https://dest.example.net/base',
        preservePath: true,
        enabled: true,
      },
      HOST,
    );
    await seedRoute(
      {
        path: '/docs/*',
        type: 'proxy',
        target: 'https://upstream.example.net/base',
        enabled: true,
      },
      HOST,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records no click for a preservePath remainder that cannot be aligned', async () => {
    expect(await visit('/zzr%2Fa/b')).toBe(404);
    expect(await count('link_clicks')).toBe(0);
    expect(await eventTypes()).toEqual(['not_found']);
    // The aligned path is a click, as before
    expect(await visit('/zzr/a/b')).toBe(302);
    expect(await count('link_clicks')).toBe(1);
  });

  it('records no proxy request for a refused proxy segment, fetching nothing', async () => {
    expect(await visit('/docs/..%5cadmin')).toBe(404);
    expect(await count('proxy_requests')).toBe(0);
    expect(await eventTypes()).toEqual(['not_found']);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
