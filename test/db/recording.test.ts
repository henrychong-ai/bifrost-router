import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import {
  recordClick,
  recordPageView,
  recordFileDownload,
  recordProxyRequest,
  recordAuditLog,
} from '../../src/db/analytics';
import type {
  LinkClickData,
  PageViewData,
  FileDownloadData,
  ProxyRequestData,
  AuditLogData,
} from '../../src/db/analytics';

/**
 * SQL helper to create all analytics tables.
 * Column definitions match the Drizzle schema in src/db/schema.ts.
 */
async function createTables(db: D1Database) {
  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS link_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      slug TEXT NOT NULL,
      target_url TEXT NOT NULL,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      http_protocol TEXT,
      timezone TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      http_protocol TEXT,
      timezone TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS file_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      content_type TEXT,
      file_size INTEGER,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      cache_status TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      target_url TEXT NOT NULL,
      response_status INTEGER,
      content_type TEXT,
      content_length INTEGER,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_login TEXT,
      actor_name TEXT,
      path TEXT,
      details TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();
}

describe('recording functions', () => {
  beforeAll(async () => {
    await createTables(env.DB);
  });

  // ---------------------------------------------------------------------------
  // recordClick
  // ---------------------------------------------------------------------------
  describe('recordClick', () => {
    it('inserts a row with minimal required fields', async () => {
      const data: LinkClickData = {
        domain: 'link.example.com',
        slug: '/minimal',
        targetUrl: 'https://example.com',
      };

      await recordClick(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM link_clicks WHERE slug = ?')
        .bind('/minimal')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('link.example.com');
      expect(row.slug).toBe('/minimal');
      expect(row.target_url).toBe('https://example.com');
      expect(row.query_string).toBeNull();
      expect(row.referrer).toBeNull();
      expect(row.user_agent).toBeNull();
      expect(row.country).toBeNull();
      expect(row.city).toBeNull();
      expect(row.colo).toBeNull();
      expect(row.continent).toBeNull();
      expect(row.http_protocol).toBeNull();
      expect(row.timezone).toBeNull();
      expect(row.ip_address).toBeNull();
      expect(row.created_at).toBeTypeOf('number');
    });

    it('inserts a row with all optional fields populated', async () => {
      const data: LinkClickData = {
        domain: 'link.example.com',
        slug: '/full-click',
        targetUrl: 'https://github.com/your-username',
        queryString: '?utm_source=twitter',
        referrer: 'https://twitter.com',
        userAgent: 'Mozilla/5.0',
        country: 'SG',
        city: 'Singapore',
        colo: 'SIN',
        continent: 'AS',
        httpProtocol: 'HTTP/2',
        timezone: 'Asia/Singapore',
        ipAddress: '1.2.3.4',
      };

      await recordClick(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM link_clicks WHERE slug = ?')
        .bind('/full-click')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('link.example.com');
      expect(row.slug).toBe('/full-click');
      expect(row.target_url).toBe('https://github.com/your-username');
      expect(row.query_string).toBe('?utm_source=twitter');
      expect(row.referrer).toBe('https://twitter.com');
      expect(row.user_agent).toBe('Mozilla/5.0');
      expect(row.country).toBe('SG');
      expect(row.city).toBe('Singapore');
      expect(row.colo).toBe('SIN');
      expect(row.continent).toBe('AS');
      expect(row.http_protocol).toBe('HTTP/2');
      expect(row.timezone).toBe('Asia/Singapore');
      expect(row.ip_address).toBe('1.2.3.4');
    });

    it('does not throw on database error (swallows errors)', async () => {
      const fakeDb = {
        prepare: () => {
          throw new Error('DB unavailable');
        },
      } as unknown as D1Database;

      await expect(
        recordClick(fakeDb, {
          domain: 'link.example.com',
          slug: '/err',
          targetUrl: 'https://example.com',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // recordPageView
  // ---------------------------------------------------------------------------
  describe('recordPageView', () => {
    it('inserts a row with minimal required fields', async () => {
      const data: PageViewData = {
        domain: 'example.com',
        path: '/about',
      };

      await recordPageView(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM page_views WHERE path = ?')
        .bind('/about')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.path).toBe('/about');
      expect(row.query_string).toBeNull();
      expect(row.referrer).toBeNull();
      expect(row.user_agent).toBeNull();
      expect(row.country).toBeNull();
      expect(row.created_at).toBeTypeOf('number');
    });

    it('inserts a row with all optional fields populated', async () => {
      const data: PageViewData = {
        domain: 'example.com',
        path: '/full-view',
        queryString: '?page=2',
        referrer: 'https://google.com',
        userAgent: 'Chrome/120',
        country: 'MY',
        city: 'Kuala Lumpur',
        colo: 'KUL',
        continent: 'AS',
        httpProtocol: 'HTTP/3',
        timezone: 'Asia/Kuala_Lumpur',
        ipAddress: '10.0.0.1',
      };

      await recordPageView(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM page_views WHERE path = ?')
        .bind('/full-view')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.path).toBe('/full-view');
      expect(row.query_string).toBe('?page=2');
      expect(row.referrer).toBe('https://google.com');
      expect(row.user_agent).toBe('Chrome/120');
      expect(row.country).toBe('MY');
      expect(row.city).toBe('Kuala Lumpur');
      expect(row.colo).toBe('KUL');
      expect(row.continent).toBe('AS');
      expect(row.http_protocol).toBe('HTTP/3');
      expect(row.timezone).toBe('Asia/Kuala_Lumpur');
      expect(row.ip_address).toBe('10.0.0.1');
    });

    it('does not throw on database error (swallows errors)', async () => {
      const fakeDb = {
        prepare: () => {
          throw new Error('DB unavailable');
        },
      } as unknown as D1Database;

      await expect(
        recordPageView(fakeDb, { domain: 'example.com', path: '/err' }),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // recordFileDownload
  // ---------------------------------------------------------------------------
  describe('recordFileDownload', () => {
    it('inserts a row with minimal required fields', async () => {
      const data: FileDownloadData = {
        domain: 'example.com',
        path: '/files/doc.pdf',
        r2Key: 'documents/doc.pdf',
      };

      await recordFileDownload(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM file_downloads WHERE r2_key = ?')
        .bind('documents/doc.pdf')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.path).toBe('/files/doc.pdf');
      expect(row.r2_key).toBe('documents/doc.pdf');
      expect(row.content_type).toBeNull();
      expect(row.file_size).toBeNull();
      expect(row.cache_status).toBeNull();
      expect(row.query_string).toBeNull();
      expect(row.referrer).toBeNull();
      expect(row.created_at).toBeTypeOf('number');
    });

    it('inserts a row with all optional fields populated', async () => {
      const data: FileDownloadData = {
        domain: 'example.com',
        path: '/files/full-doc.pdf',
        r2Key: 'documents/full-doc.pdf',
        contentType: 'application/pdf',
        fileSize: 1048576,
        cacheStatus: 'HIT',
        queryString: '?v=2',
        referrer: 'https://example.com/docs',
        userAgent: 'Safari/17',
        country: 'US',
        city: 'New York',
        colo: 'EWR',
        continent: 'NA',
        httpProtocol: 'HTTP/2',
        timezone: 'America/New_York',
        ipAddress: '192.168.1.1',
      };

      await recordFileDownload(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM file_downloads WHERE r2_key = ?')
        .bind('documents/full-doc.pdf')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.path).toBe('/files/full-doc.pdf');
      expect(row.r2_key).toBe('documents/full-doc.pdf');
      expect(row.content_type).toBe('application/pdf');
      expect(row.file_size).toBe(1048576);
      expect(row.cache_status).toBe('HIT');
      expect(row.query_string).toBe('?v=2');
      expect(row.referrer).toBe('https://example.com/docs');
      expect(row.user_agent).toBe('Safari/17');
      expect(row.country).toBe('US');
      expect(row.city).toBe('New York');
      expect(row.colo).toBe('EWR');
      expect(row.continent).toBe('NA');
      expect(row.http_protocol).toBe('HTTP/2');
      expect(row.timezone).toBe('America/New_York');
      expect(row.ip_address).toBe('192.168.1.1');
    });

    it('does not throw on database error (swallows errors)', async () => {
      const fakeDb = {
        prepare: () => {
          throw new Error('DB unavailable');
        },
      } as unknown as D1Database;

      await expect(
        recordFileDownload(fakeDb, {
          domain: 'example.com',
          path: '/err',
          r2Key: 'err',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // recordProxyRequest
  // ---------------------------------------------------------------------------
  describe('recordProxyRequest', () => {
    it('inserts a row with minimal required fields', async () => {
      const data: ProxyRequestData = {
        domain: 'example.com',
        path: '/api/data',
        targetUrl: 'https://api.example.com/api/data',
      };

      await recordProxyRequest(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM proxy_requests WHERE path = ?')
        .bind('/api/data')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.path).toBe('/api/data');
      expect(row.target_url).toBe('https://api.example.com/api/data');
      expect(row.response_status).toBeNull();
      expect(row.content_type).toBeNull();
      expect(row.content_length).toBeNull();
      expect(row.query_string).toBeNull();
      expect(row.referrer).toBeNull();
      expect(row.created_at).toBeTypeOf('number');
    });

    it('inserts a row with all optional fields populated', async () => {
      const data: ProxyRequestData = {
        domain: 'example.com',
        path: '/api/full-proxy',
        targetUrl: 'https://api.example.com/api/full-proxy',
        responseStatus: 200,
        contentType: 'application/json',
        contentLength: 4096,
        queryString: '?format=json',
        referrer: 'https://example.com',
        userAgent: 'Axios/1.6',
        country: 'JP',
        city: 'Tokyo',
        colo: 'NRT',
        continent: 'AS',
        httpProtocol: 'HTTP/2',
        timezone: 'Asia/Tokyo',
        ipAddress: '203.0.113.42',
      };

      await recordProxyRequest(env.DB, data);

      const result = await env.DB.prepare('SELECT * FROM proxy_requests WHERE path = ?')
        .bind('/api/full-proxy')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.path).toBe('/api/full-proxy');
      expect(row.target_url).toBe('https://api.example.com/api/full-proxy');
      expect(row.response_status).toBe(200);
      expect(row.content_type).toBe('application/json');
      expect(row.content_length).toBe(4096);
      expect(row.query_string).toBe('?format=json');
      expect(row.referrer).toBe('https://example.com');
      expect(row.user_agent).toBe('Axios/1.6');
      expect(row.country).toBe('JP');
      expect(row.city).toBe('Tokyo');
      expect(row.colo).toBe('NRT');
      expect(row.continent).toBe('AS');
      expect(row.http_protocol).toBe('HTTP/2');
      expect(row.timezone).toBe('Asia/Tokyo');
      expect(row.ip_address).toBe('203.0.113.42');
    });

    it('does not throw on database error (swallows errors)', async () => {
      const fakeDb = {
        prepare: () => {
          throw new Error('DB unavailable');
        },
      } as unknown as D1Database;

      await expect(
        recordProxyRequest(fakeDb, {
          domain: 'example.com',
          path: '/err',
          targetUrl: 'https://example.com',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // recordAuditLog
  // ---------------------------------------------------------------------------
  describe('recordAuditLog', () => {
    it('inserts a row with minimal required fields', async () => {
      const data: AuditLogData = {
        domain: 'example.com',
        action: 'create',
      };

      await recordAuditLog(env.DB, data);

      const result = await env.DB.prepare(
        "SELECT * FROM audit_logs WHERE domain = ? AND action = 'create'",
      )
        .bind('example.com')
        .all();

      expect(result.results.length).toBeGreaterThanOrEqual(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.action).toBe('create');
      expect(row.actor_login).toBeNull();
      expect(row.actor_name).toBeNull();
      expect(row.path).toBeNull();
      expect(row.details).toBeNull();
      expect(row.ip_address).toBeNull();
      expect(row.created_at).toBeTypeOf('number');
    });

    it('inserts a row with all optional fields populated', async () => {
      const data: AuditLogData = {
        domain: 'example.com',
        action: 'update',
        actorLogin: 'admin@example.com',
        actorName: 'Admin User',
        path: '/linkedin',
        details: JSON.stringify({ before: { target: 'old' }, after: { target: 'new' } }),
        ipAddress: '10.0.0.5',
      };

      await recordAuditLog(env.DB, data);

      const result = await env.DB.prepare(
        "SELECT * FROM audit_logs WHERE action = 'update' AND actor_login = ?",
      )
        .bind('admin@example.com')
        .all();

      expect(result.results.length).toBe(1);
      const row = result.results[0];
      expect(row.domain).toBe('example.com');
      expect(row.action).toBe('update');
      expect(row.actor_login).toBe('admin@example.com');
      expect(row.actor_name).toBe('Admin User');
      expect(row.path).toBe('/linkedin');
      expect(row.details).toBe(
        JSON.stringify({ before: { target: 'old' }, after: { target: 'new' } }),
      );
      expect(row.ip_address).toBe('10.0.0.5');
    });

    it('records all audit action types', async () => {
      const actions = ['delete', 'toggle', 'seed', 'migrate'] as const;

      for (const action of actions) {
        await recordAuditLog(env.DB, {
          domain: 'example.com',
          action,
          actorLogin: 'test-runner',
          path: `/action-test-${action}`,
        });
      }

      for (const action of actions) {
        const result = await env.DB.prepare('SELECT * FROM audit_logs WHERE path = ?')
          .bind(`/action-test-${action}`)
          .all();

        expect(result.results.length).toBe(1);
        expect(result.results[0].action).toBe(action);
      }
    });

    it('does not throw on database error (swallows errors)', async () => {
      const fakeDb = {
        prepare: () => {
          throw new Error('DB unavailable');
        },
      } as unknown as D1Database;

      await expect(
        recordAuditLog(fakeDb, {
          domain: 'example.com',
          action: 'create',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
