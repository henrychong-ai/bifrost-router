import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db';
import { getAnalyticsSummary } from '../../src/db/queries';

const LEGACY_ROWS_PER_STREAM = 200;
const UNIFIED_ROWS = 300;
const SUMMARY_RUNS = 3;
const MAXIMUM_MEDIAN_MS = 20;
const TEST_ENV = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
const RUN_GATE = TEST_ENV.VITE_RUN_ANALYTICS_PERFORMANCE_GATE === '1';

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function createSchema(): Promise<void> {
  const statements = [
    `CREATE TABLE link_clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
      slug TEXT NOT NULL, target_url TEXT NOT NULL, query_string TEXT, referrer TEXT,
      user_agent TEXT, country TEXT, city TEXT, colo TEXT, continent TEXT,
      http_protocol TEXT, timezone TEXT, ip_address TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE page_views (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
      path TEXT NOT NULL, query_string TEXT, referrer TEXT, user_agent TEXT, country TEXT,
      city TEXT, colo TEXT, continent TEXT, http_protocol TEXT, timezone TEXT,
      ip_address TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE file_downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
      path TEXT NOT NULL, r2_key TEXT NOT NULL, content_type TEXT, file_size INTEGER,
      query_string TEXT, referrer TEXT, user_agent TEXT, country TEXT, city TEXT, colo TEXT,
      continent TEXT, timezone TEXT, http_protocol TEXT, ip_address TEXT, cache_status TEXT,
      created_at INTEGER NOT NULL)`,
    `CREATE TABLE proxy_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
      path TEXT NOT NULL, target_url TEXT NOT NULL, response_status INTEGER, content_type TEXT,
      content_length INTEGER, query_string TEXT, referrer TEXT, user_agent TEXT, country TEXT,
      city TEXT, colo TEXT, continent TEXT, timezone TEXT, http_protocol TEXT, ip_address TEXT,
      created_at INTEGER NOT NULL)`,
    `CREATE TABLE unified_traffic_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL, path TEXT NOT NULL, event_type TEXT NOT NULL, outcome TEXT NOT NULL,
      response_status INTEGER NOT NULL, response_bytes INTEGER, cache_status TEXT, country TEXT,
      traffic_class TEXT NOT NULL, latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    'CREATE INDEX idx_link_clicks_domain_created ON link_clicks(domain, created_at)',
    'CREATE INDEX idx_page_views_domain_created ON page_views(domain, created_at)',
    'CREATE INDEX idx_file_downloads_domain ON file_downloads(domain)',
    'CREATE INDEX idx_file_downloads_created_at ON file_downloads(created_at)',
    'CREATE INDEX idx_proxy_requests_domain ON proxy_requests(domain)',
    'CREATE INDEX idx_proxy_requests_created_at ON proxy_requests(created_at)',
    'CREATE INDEX idx_unified_traffic_domain_created_at ON unified_traffic_events(domain, created_at)',
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

async function seedRows(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < LEGACY_ROWS_PER_STREAM; index += 1) {
    const path = `/route-${index % 30}`;
    const createdAt = now - (index % 20) * 3_600;
    statements.push(
      env.DB.prepare(
        'INSERT INTO link_clicks (domain, slug, target_url, user_agent, country, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        'example.com',
        path,
        `https://destination.example/${index % 20}`,
        'Mozilla/5.0',
        'SG',
        createdAt,
      ),
      env.DB.prepare(
        'INSERT INTO page_views (domain, path, user_agent, country, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind('example.com', path, 'Mozilla/5.0', 'SG', createdAt),
      env.DB.prepare(
        'INSERT INTO file_downloads (domain, path, r2_key, file_size, user_agent, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind('example.com', path, `files/${index % 30}`, 1024, 'Mozilla/5.0', 'SG', createdAt),
      env.DB.prepare(
        'INSERT INTO proxy_requests (domain, path, target_url, response_status, user_agent, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        'example.com',
        path,
        `https://upstream.example/${index % 30}`,
        200,
        'Mozilla/5.0',
        'SG',
        createdAt,
      ),
    );
  }
  for (let index = 0; index < UNIFIED_ROWS; index += 1) {
    statements.push(
      env.DB.prepare(`INSERT INTO unified_traffic_events
      (domain, path, event_type, outcome, response_status, response_bytes, cache_status,
       country, traffic_class, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        'example.com',
        `/public-${index % 40}`,
        'service',
        'success',
        200,
        2048,
        'HIT',
        'SG',
        'browser',
        10,
        now - (index % 20) * 3_600,
      ),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100));
  }
}

describe.skipIf(!RUN_GATE)('analytics summary performance', () => {
  beforeAll(async () => {
    await createSchema();
    await seedRows();
  });

  it('stays within the reviewed deterministic D1 ceiling', async () => {
    const db = createDb(env.DB);
    const options = {
      domain: 'example.com',
      days: 30,
      unifiedTrafficEnabled: true,
      unifiedTrafficMode: 'shadow' as const,
      unifiedTrafficCutoverAt: 1,
      unifiedTrafficRetentionDays: 30,
    };
    await getAnalyticsSummary(db, options);
    const runTimesMs = [];
    for (let run = 0; run < SUMMARY_RUNS; run += 1) {
      const startedAt = performance.now();
      await getAnalyticsSummary(db, options);
      runTimesMs.push(performance.now() - startedAt);
    }
    const medianMs = median(runTimesMs);
    const result = {
      seedRows: LEGACY_ROWS_PER_STREAM * 4 + UNIFIED_ROWS,
      runTimesMs,
      medianMs,
      maximumMedianMs: MAXIMUM_MEDIAN_MS,
      passed: medianMs <= MAXIMUM_MEDIAN_MS,
    };
    console.log(`ANALYTICS_PERFORMANCE_JSON:${JSON.stringify(result)}`);
    expect(runTimesMs).toHaveLength(SUMMARY_RUNS);
    expect(medianMs).toBeLessThanOrEqual(MAXIMUM_MEDIAN_MS);
  });
});
