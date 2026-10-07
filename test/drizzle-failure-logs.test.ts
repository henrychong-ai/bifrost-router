import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import {
  pruneUnifiedTrafficEvents,
  recordAuditLog,
  recordClick,
  recordFileDownload,
  recordPageView,
  recordProxyRequest,
  recordUnifiedTrafficEvent,
} from '../src/db/analytics';
import { listFeedback } from '../src/db/feedback';
import { getFileComment, listFileComments } from '../src/db/file-comments';
import { linkClicks } from '../src/db/schema';

/**
 * A failed D1 statement through the REAL Drizzle adapter (v1.39.0). Drizzle
 * wraps the failure in an error whose message holds the SQL and every bound
 * parameter: the visitor's path, query, referrer and user agent for an
 * analytics row, an object key or comment for a file note. Every catch that
 * logs a D1 failure logs the error's class only. The failure is real: this
 * file's D1 has no tables (storage is isolated per test file), so every
 * statement fails with "no such table".
 */
const CHANNELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const MARKER = 'visitor-marker-4Wp';

let output: string[] = [];
beforeEach(() => {
  output = [];
  for (const channel of CHANNELS) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const visitor = {
  domain: 'links.example.com',
  queryString: `?token=${MARKER}`,
  referrer: `https://example.net/${MARKER}`,
  userAgent: `agent-${MARKER}`,
  ipAddress: '203.0.113.7',
};

describe('a D1 failure through Drizzle logs no request data', () => {
  it('control: the tables are missing here', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('link_clicks', 'file_comments', 'feedback', 'audit_logs')",
    ).all();
    expect(tables.results).toEqual([]);
  });

  it('control: Drizzle’s own error message carries the bound parameters', async () => {
    const error = await createDb(env.DB)
      .insert(linkClicks)
      .values({
        domain: 'links.example.com',
        slug: `/${MARKER}`,
        targetUrl: 'https://example.com/',
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain(MARKER);
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      'recordClick',
      () =>
        recordClick(env.DB, {
          ...visitor,
          slug: `/${MARKER}`,
          targetUrl: `https://example.com/${MARKER}`,
        }),
    ],
    ['recordPageView', () => recordPageView(env.DB, { ...visitor, path: `/${MARKER}` })],
    [
      'recordFileDownload',
      () =>
        recordFileDownload(env.DB, {
          ...visitor,
          path: `/${MARKER}`,
          r2Key: `files/${MARKER}.pdf`,
        }),
    ],
    [
      'recordProxyRequest',
      () =>
        recordProxyRequest(env.DB, {
          ...visitor,
          path: `/${MARKER}`,
          targetUrl: `https://example.com/${MARKER}`,
          responseStatus: 200,
        }),
    ],
    [
      'recordUnifiedTrafficEvent',
      () =>
        recordUnifiedTrafficEvent(env.DB, {
          domain: 'links.example.com',
          path: `/${MARKER}`,
          eventType: 'redirect',
          outcome: 'success',
          responseStatus: 302,
          responseBytes: null,
          cacheStatus: null,
          country: null,
          trafficClass: 'human',
          latencyMs: 1,
        }),
    ],
    ['pruneUnifiedTrafficEvents', () => pruneUnifiedTrafficEvents(env.DB, 30)],
    [
      'recordAuditLog',
      () =>
        recordAuditLog(env.DB, {
          domain: 'links.example.com',
          action: 'update',
          actorLogin: 'api-key',
          path: '/promo',
          details: JSON.stringify({ target: `https://example.com/${MARKER}` }),
          ipAddress: '203.0.113.7',
        } as Parameters<typeof recordAuditLog>[1]),
    ],
    ['getFileComment', () => getFileComment(env.DB, 'files', `docs/${MARKER}.pdf`)],
    ['listFileComments', () => listFileComments(env.DB, 'files', [`docs/${MARKER}.pdf`])],
    ['listFeedback', () => listFeedback(env.DB, { status: 'open' })],
  ])('%s logs the failure as a class only', async (_name, call) => {
    await call();
    const failures = output.filter(line => line.includes('"errorName"'));
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) expect(line).not.toMatch(/"error":|Failed query|params/);
    expect(output.filter(line => line.includes(MARKER))).toEqual([]);
  });
});
