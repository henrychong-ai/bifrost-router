/**
 * Unit tests for the Cloudflare account audit-log poller (v1.28.0, ported
 * from Fusang bifrost v1.51.0).
 *
 * Layer 2 of the external R2 operations audit capture
 * (see README.md "External R2 operations audit capture"). Exercises:
 *  - flag gate (CF_AUDIT_POLL !== 'on' → no fetch, no rows)
 *  - unconfigured guard (missing token/account id → no fetch)
 *  - R2-scope filtering (only r2/queue resources recorded)
 *  - real actor mapping (email, ip, source='cf_audit', cf_audit_id in details)
 *  - watermark cursor written to poll_cursors and honoured on re-poll
 *  - idempotency backstop (same cf entry id never recorded twice)
 *  - API failure logged without throwing
 *
 * Global fetch is stubbed per test. This repo has no shared test/setup.ts, so
 * stub hygiene is local to this file: beforeEach unstubs between tests and a
 * file-level afterAll restores globals so nothing leaks into other suites.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { pollCfAuditLogs } from '../../src/audit/cf-audit-poll';
import type { Bindings } from '../../src/types';

const AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    domain TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_login TEXT,
    actor_name TEXT,
    path TEXT,
    details TEXT,
    ip_address TEXT,
    source TEXT NOT NULL DEFAULT 'bifrost',
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL
  )`;

const CURSORS_DDL = `
  CREATE TABLE IF NOT EXISTS poll_cursors (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`;

interface AuditRow {
  action: string;
  actor_login: string | null;
  ip_address: string | null;
  path: string | null;
  details: string | null;
  source: string;
}

function cfEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cf-entry-1',
    action: { type: 'update', result: true },
    actor: { id: 'actor-1', email: 'henry@example.com', type: 'user', ip: '1.2.3.4' },
    resource: { type: 'r2.bucket', id: 'files' },
    interface: 'UI',
    metadata: { zone: 'none' },
    oldValue: '',
    newValue: { lifecycle: 'updated' },
    when: '2026-06-10T08:00:00Z',
    ...overrides,
  };
}

function stubFetch(pages: Record<string, unknown>[][]): ReturnType<typeof vi.fn> {
  let call = 0;
  const stub = vi.fn(async () => {
    const result = pages[call] ?? [];
    call++;
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

function envWith(overrides: Partial<Bindings>): Bindings {
  return {
    ...env,
    CF_AUDIT_POLL: 'on',
    CF_AUDIT_API_TOKEN: 'test-audit-token',
    CF_ACCOUNT_ID: 'test-account-id',
    ...overrides,
  } as Bindings;
}

async function allAudit(): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT action, actor_login, ip_address, path, details, source FROM audit_logs ORDER BY id',
  ).all<AuditRow>();
  return results;
}

describe('pollCfAuditLogs', () => {
  beforeAll(async () => {
    await env.DB.prepare(AUDIT_DDL).run();
    await env.DB.prepare(CURSORS_DDL).run();
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM audit_logs').run();
    await env.DB.prepare('DELETE FROM poll_cursors').run();
    vi.unstubAllGlobals();
  });

  // No shared test/setup.ts in this repo — restore the fetch stub at file end
  // so it never leaks into another suite's isolate.
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('pollCfAuditLogs — gates', () => {
    it('no-ops when the flag is off', async () => {
      const stub = stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({ CF_AUDIT_POLL: 'off' }));
      expect(stub).not.toHaveBeenCalled();
      expect(await allAudit()).toHaveLength(0);
    });

    it('no-ops (with a warning, not a throw) when the token is missing', async () => {
      const stub = stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({ CF_AUDIT_API_TOKEN: undefined }));
      expect(stub).not.toHaveBeenCalled();
      expect(await allAudit()).toHaveLength(0);
    });
  });

  describe('pollCfAuditLogs — recording', () => {
    it('records an R2-scoped entry with the real actor and cf_audit source', async () => {
      stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({}));

      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('cf_config_change');
      expect(rows[0].source).toBe('cf_audit');
      expect(rows[0].actor_login).toBe('henry@example.com');
      expect(rows[0].ip_address).toBe('1.2.3.4');
      expect(rows[0].path).toBe('r2.bucket/files');
      const details = JSON.parse(rows[0].details ?? '{}');
      expect(details.cf_audit_id).toBe('cf-entry-1');
      expect(details.actionType).toBe('update');
    });

    it('filters out entries that are not R2/queue scoped', async () => {
      stubFetch([
        [
          cfEntry(),
          cfEntry({ id: 'cf-entry-2', resource: { type: 'dns_record', id: 'rec-1' } }),
          cfEntry({ id: 'cf-entry-3', resource: { type: 'queue', id: 'bifrost-r2-events' } }),
        ],
      ]);
      await pollCfAuditLogs(envWith({}));

      const rows = await allAudit();
      expect(rows).toHaveLength(2);
      expect(rows.map(r => JSON.parse(r.details ?? '{}').cf_audit_id)).toEqual([
        'cf-entry-1',
        'cf-entry-3',
      ]);
    });

    it('writes the watermark cursor and skips boundary ids on re-poll', async () => {
      stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({}));

      const cursor = await env.DB.prepare(
        "SELECT value FROM poll_cursors WHERE name = 'cf-audit-poll'",
      ).first<{ value: string }>();
      expect(cursor).not.toBeNull();
      const parsed = JSON.parse(cursor?.value ?? '{}');
      expect(parsed.since).toBe('2026-06-10T08:00:00Z');
      expect(parsed.boundaryIds).toContain('cf-entry-1');

      // Re-poll returning the same boundary entry — must not duplicate the row
      // NOR grow the boundary set (previously appended one duplicate id per run).
      stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({}));
      expect(await allAudit()).toHaveLength(1);
      const cursor2 = await env.DB.prepare(
        "SELECT value FROM poll_cursors WHERE name = 'cf-audit-poll'",
      ).first<{ value: string }>();
      expect(JSON.parse(cursor2?.value ?? '{}').boundaryIds).toEqual(['cf-entry-1']);
    });

    it('idempotency backstop: same cf id is not recorded twice even without a cursor', async () => {
      stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({}));
      // Simulate cursor loss
      await env.DB.prepare('DELETE FROM poll_cursors').run();
      stubFetch([[cfEntry()]]);
      await pollCfAuditLogs(envWith({}));

      expect(await allAudit()).toHaveLength(1);
    });

    it('logs and returns (no throw) on API failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('upstream error', { status: 500 })),
      );
      await expect(pollCfAuditLogs(envWith({}))).resolves.toBeUndefined();
      expect(await allAudit()).toHaveLength(0);
    });
  });
});
