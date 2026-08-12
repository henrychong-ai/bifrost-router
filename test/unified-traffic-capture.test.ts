import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureUnifiedTrafficResponse } from '../src/index';
import type { AppEnv, Bindings } from '../src/types';

describe('unified traffic capture middleware', () => {
  beforeAll(async () => {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS unified_traffic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        path TEXT NOT NULL,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_bytes INTEGER,
        cache_status TEXT,
        country TEXT,
        traffic_class TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM unified_traffic_events').run();
  });

  async function request(mode: 'off' | 'shadow', userAgent = 'Mozilla/5.0') {
    const waits: Promise<unknown>[] = [];
    const app = new Hono<AppEnv>();
    app.use('*', captureUnifiedTrafficResponse);
    app.get('/report', c => {
      c.set('unifiedEventType', 'proxy');
      return c.text('ok', 200, { 'Content-Length': '2', 'X-Cache-Status': 'hit' });
    });
    const bindings: Bindings = {
      ...(env as unknown as Bindings),
      ENVIRONMENT: 'development',
      VERSION: 'test',
      UNIFIED_TRAFFIC_MODE: mode,
      UNIFIED_TRAFFIC_CUTOVER_AT: '2026-01-01T00:00:00Z',
      UNIFIED_TRAFFIC_RETENTION_DAYS: '30',
      ADMIN_API_DOMAIN: 'bifrost.example.com',
    };
    const response = await app.fetch(
      new Request('https://example.com/report?token=not-persisted', {
        headers: { 'user-agent': userAgent },
      }),
      bindings,
      {
        waitUntil: promise => waits.push(promise),
        passThroughOnException: () => undefined,
        props: {},
      },
    );
    await Promise.all(waits);
    return response;
  }

  it('writes one privacy-bounded row in active shadow mode', async () => {
    expect((await request('shadow')).status).toBe(200);
    const row = await env.DB.prepare(
      'SELECT domain, path, event_type, outcome, response_status, response_bytes, cache_status, traffic_class FROM unified_traffic_events',
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      domain: 'example.com',
      path: '/report',
      event_type: 'proxy',
      outcome: 'success',
      response_status: 200,
      response_bytes: 2,
      cache_status: 'HIT',
      traffic_class: 'browser',
    });
    expect(JSON.stringify(row)).not.toContain('not-persisted');
    expect(JSON.stringify(row)).not.toContain('Mozilla');
  });

  it('performs no write when disabled or for Cloudflare Health Checks', async () => {
    await request('off');
    await request('shadow', 'Cloudflare-Healthchecks/1.0');
    const count = await env.DB.prepare('SELECT COUNT(*) count FROM unified_traffic_events').first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });
});
