/**
 * Unit tests for the Cloudflare account audit-log poller (v1.28.0).
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

import { env } from 'cloudflare:test';
import { canonicalJson } from '@bifrost/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_UNPARSED_PER_RUN,
  pollCfAuditLogs,
  UNPARSED_DEDUPE_WINDOW_SECS,
} from '../../src/audit/cf-audit-poll';
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
    actor: { id: 'actor-1', email: 'admin@example.com', type: 'user', ip: '1.2.3.4' },
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
  const stub = vi.fn<typeof fetch>(async () => {
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
    // Freeze the clock just after the stubbed entries' `when` (2026-06-10T08:00Z)
    // so the poller's first-run lookback window (now − 24h) always contains them.
    // Keeps the watermark assertions deterministic — de-pins a former wall-clock
    // dependency. Fakes Date only, leaving real timers so async is unaffected.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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
      expect(rows[0].actor_login).toBe('admin@example.com');
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

// v1.38.0: the stored cursor and the API body are validated before use, and
// a malformed entry is recorded in a minimal shape rather than trusted or lost
/**
 * A stub of the audit_logs API that honours `since` (exclusive), `page` and
 * `per_page` over a fixed, time-ordered entry list, like the real one.
 */
function stubAuditApi(entries: Record<string, unknown>[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const since = Date.parse(url.searchParams.get('since') ?? '');
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page'));
      const newer = entries.filter(entry => Date.parse(String(entry['when'])) > since);
      const result = newer.slice((page - 1) * perPage, page * perPage);
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }),
  );
}

const unparsedIds = async () =>
  (await allAudit())
    .map(row => JSON.parse(row.details ?? '{}') as { cf_audit_id: string; unparsed?: boolean })
    .filter(detail => detail.unparsed)
    .map(detail => detail.cf_audit_id);

describe('pollCfAuditLogs boundary validation', () => {
  const CF_ENTRY_WHEN = '2026-06-10T08:00:00Z';
  beforeAll(async () => {
    await env.DB.prepare(AUDIT_DDL).run();
    await env.DB.prepare(CURSORS_DDL).run();
  });
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM audit_logs').run();
    await env.DB.prepare('DELETE FROM poll_cursors').run();
    vi.unstubAllGlobals();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['not JSON', '{"since":"2026-'],
    ['the wrong shape', JSON.stringify({ since: 42, boundaryIds: 'cf-entry-1' })],
    ['an empty since', JSON.stringify({ since: '', boundaryIds: [] })],
    // A since that passes a string check but is no timestamp used to make
    // toISOString() throw on every run, forever
    ['a since that is not a date', JSON.stringify({ since: 'not-a-date', boundaryIds: [] })],
    // A zone-less time depends on the runtime's zone
    ['a since with no zone', JSON.stringify({ since: '2026-06-10T08:00:00', boundaryIds: [] })],
    ['a since that is no real time', JSON.stringify({ since: '2026-13-45T99:00:00Z' })],
  ])(
    'restarts the window from the first-run lookback when the cursor is %s',
    async (_label, value) => {
      await env.DB.prepare('INSERT INTO poll_cursors (name, value) VALUES (?, ?)')
        .bind('cf-audit-poll', value)
        .run();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stub = stubFetch([[cfEntry()]]);
      const before = Date.now();
      await pollCfAuditLogs(envWith({}));
      const url = new URL(String(stub.mock.calls[0]?.[0]));
      const since = Date.parse(url.searchParams.get('since') ?? '');
      expect(before - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(before - since).toBeLessThan(24 * 60 * 60 * 1000 + 60_000);
      expect(await allAudit()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          message: 'boundary-invalid-value',
          category: 'audit-cursor',
        }),
      );
      const cursor = await env.DB.prepare(
        "SELECT value FROM poll_cursors WHERE name = 'cf-audit-poll'",
      ).first<{ value: string }>();
      expect((JSON.parse(cursor?.value ?? '{}') as { since?: string }).since).toBe(CF_ENTRY_WHEN);
    },
  );

  it.each([
    ['not JSON', 'upstream <html>'],
    ['a result that is not an array', JSON.stringify({ success: true, result: { id: 'x' } })],
    ['a JSON string', JSON.stringify('cf-entry-1')],
  ])('records nothing and does not throw when the API body is %s', async (_label, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(pollCfAuditLogs(envWith({}))).resolves.toBeUndefined();
    expect(await allAudit()).toHaveLength(0);
    expect(JSON.stringify(error.mock.calls)).toContain(
      'CF audit_logs API returned an invalid body',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('upstream <html>');
  });

  it('records a malformed entry minimally (id, time, unparsed), never its content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = [
      cfEntry({ id: 'cf-entry-bad', resource: { type: 42, id: 'secret-bucket' } }),
      'not an entry' as unknown as Record<string, unknown>,
      cfEntry({ id: 'cf-entry-ok' }),
    ];
    stubFetch([entries]);
    await pollCfAuditLogs(envWith({}));
    const rows = await allAudit();
    const details = rows.map(row => JSON.parse(row.details ?? '{}') as Record<string, unknown>);
    const ids = details.map(detail => detail['cf_audit_id']);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(
      expect.arrayContaining([
        'cf-entry-bad',
        'cf-entry-ok',
        expect.stringMatching(/^unparsed:[0-9a-f]{32}$/),
      ]),
    );
    const bad = rows.find(row => (row.details ?? '').includes('"cf-entry-bad"'));
    expect(JSON.parse(bad?.details ?? '{}')).toEqual({
      cf_audit_id: 'cf-entry-bad',
      unparsed: true,
      when: CF_ENTRY_WHEN,
    });
    expect(bad?.path).toBe('unknown/unparsed');
    expect(JSON.stringify(rows)).not.toContain('secret-bucket');
    // A second run over the same entries records nothing twice
    stubFetch([entries]);
    await pollCfAuditLogs(envWith({}));
    expect(await allAudit()).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        message: 'boundary-invalid-value',
        category: 'cf-audit-entry',
      }),
    );
  });

  it('records an unparsed entry only in scope, and at most the per-run cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r2 = Array.from({ length: 30 }, (_, i) =>
      cfEntry({ id: `flood-${i}`, actor: 7, resource: { type: 'r2.bucket', id: 'files' } }),
    );
    const dns = Array.from({ length: 10 }, (_, i) =>
      cfEntry({ id: `dns-${i}`, actor: 7, resource: { type: 'dns_record', id: 'x' } }),
    );
    stubFetch([[...dns, ...r2]]);
    await pollCfAuditLogs(envWith({}));
    const ids = (await allAudit()).map(
      row => (JSON.parse(row.details ?? '{}') as { cf_audit_id: string }).cf_audit_id,
    );
    expect(ids).toHaveLength(MAX_UNPARSED_PER_RUN);
    expect(ids.every(id => id.startsWith('flood-'))).toBe(true);
    expect(
      warn.mock.calls.filter(call => String(call[0]).includes('cf-audit-unparsed-cap')),
    ).toHaveLength(1);
  });

  it('paginates on the raw page size: a full page with one invalid entry still fetches page 2', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page1 = [
      'not an entry' as unknown as Record<string, unknown>,
      ...Array.from({ length: 99 }, (_, i) =>
        cfEntry({ id: `p1-${i}`, resource: { type: 'dns_record', id: 'x' } }),
      ),
    ];
    const stub = stubFetch([page1, [cfEntry({ id: 'p2-r2' })]]);
    await pollCfAuditLogs(envWith({}));
    expect(stub).toHaveBeenCalledTimes(2);
    const ids = (await allAudit()).map(
      row => (JSON.parse(row.details ?? '{}') as { cf_audit_id: string }).cf_audit_id,
    );
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining(['p2-r2', expect.stringMatching(/^unparsed:/)]));
  });

  it('records a flood of malformed entries over several runs, never skipping one at the cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 50 malformed in-scope entries, one second apart, and a valid one after
    const flood = Array.from({ length: 50 }, (_, i) =>
      cfEntry({
        id: `flood-${String(i).padStart(2, '0')}`,
        actor: 7,
        when: new Date(Date.parse(CF_ENTRY_WHEN) + i * 1000).toISOString(),
      }),
    );
    const last = cfEntry({
      id: 'after-flood',
      when: new Date(Date.parse(CF_ENTRY_WHEN) + 60_000).toISOString(),
    });
    stubAuditApi([...flood, last]);

    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toHaveLength(MAX_UNPARSED_PER_RUN);
    // The valid entry after the flood waits for a later run: the watermark
    // never moves past an entry that was not recorded
    expect((await allAudit()).map(row => row.details)).not.toContainEqual(
      expect.stringContaining('after-flood'),
    );
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toHaveLength(2 * MAX_UNPARSED_PER_RUN);
    await pollCfAuditLogs(envWith({}));
    expect((await unparsedIds()).toSorted()).toEqual(flood.map(entry => entry['id']));
    expect(JSON.stringify(await allAudit())).toContain('after-flood');
    // Nothing is recorded twice, however often it is polled again
    await pollCfAuditLogs(envWith({}));
    expect(await allAudit()).toHaveLength(51);
    expect(
      warn.mock.calls.filter(call => String(call[0]).includes('cf-audit-unparsed-cap')),
    ).toHaveLength(2);
  });

  it('names an entry without an id by its canonical JSON, whatever its key order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 3, e: 4 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { e: 4, f: 3 }] }, b: 1 }),
    );
    const entry = { when: CF_ENTRY_WHEN, resource: { id: 'x' }, action: { type: 7 } };
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    // The same entry with its keys reordered is the same entry
    stubFetch([[{ action: { type: 7 }, resource: { id: 'x' }, when: CF_ENTRY_WHEN }]]);
    await pollCfAuditLogs(envWith({}));
    const ids = await unparsedIds();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^unparsed:[0-9a-f]{32}$/);
  });

  it('recognises an unparsed entry recorded more than a day ago', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No `when`: the entry cannot be placed in time at all
    const entry = { id: 'old-unparsed', actor: 7, resource: { type: 'r2.bucket' } };
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    // Recorded when it was polled (the row's own clock is the database's, so
    // it is set explicitly), and polled again three days later
    await env.DB.prepare('UPDATE audit_logs SET created_at = ?')
      .bind(Math.floor(Date.parse('2026-06-10T12:00:00Z') / 1000))
      .run();
    vi.setSystemTime(new Date('2026-06-13T12:00:00Z'));
    await env.DB.prepare('DELETE FROM poll_cursors').run();
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toEqual(['old-unparsed']);
  });

  it('looks for a recorded unparsed id within the dedupe window only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(UNPARSED_DEDUPE_WINDOW_SECS).toBe(90 * 24 * 60 * 60);
    const entry = { id: 'ancient-unparsed', actor: 7, resource: { type: 'r2.bucket' } };
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    // A row older than the window is not looked at (the lookup stays on the index)
    await env.DB.prepare('UPDATE audit_logs SET created_at = ?')
      .bind(Math.floor(Date.now() / 1000) - UNPARSED_DEDUPE_WINDOW_SECS - 60)
      .run();
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toEqual(['ancient-unparsed', 'ancient-unparsed']);
  });

  // v1.38.0: the dedupe window runs from the run's own clock. Derived from a
  // future `when`, it started after every recorded row, so the entry was
  // recorded again on every poll until the clock passed it.
  it('records a future-dated entry once, however often it is fetched again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const future = '2030-01-01T00:00:00Z';
    const entries = [
      cfEntry({ id: 'future-parsed', when: future }),
      cfEntry({ id: 'future-unparsed', actor: 7, when: future }),
    ];
    for (let run = 0; run < 3; run++) {
      stubFetch([entries]);
      await pollCfAuditLogs(envWith({}));
      // Rows stamped with the run's own time, as the database stamps them
      await env.DB.prepare('UPDATE audit_logs SET created_at = ?')
        .bind(Math.floor(Date.now() / 1000))
        .run();
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    }
    const ids = (await allAudit()).map(
      row => (JSON.parse(row.details ?? '{}') as { cf_audit_id: string }).cf_audit_id,
    );
    expect(ids).toEqual(['future-parsed', 'future-unparsed']);
  });

  it('narrows the lookup to a day before a known, past `when`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = cfEntry({ id: 'placed-unparsed', actor: 7, when: CF_ENTRY_WHEN });
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    // A row from before the day the entry's own time allows is not looked at
    await env.DB.prepare('UPDATE audit_logs SET created_at = ?')
      .bind(Math.floor(Date.parse(CF_ENTRY_WHEN) / 1000) - 2 * 24 * 60 * 60)
      .run();
    await env.DB.prepare('DELETE FROM poll_cursors').run();
    stubFetch([[entry]]);
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toEqual(['placed-unparsed', 'placed-unparsed']);
  });

  it('never moves the cursor back, even when a run stops at the cap inside the overlap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const held = '2026-06-10T08:10:00.000Z';
    await env.DB.prepare('INSERT INTO poll_cursors (name, value) VALUES (?, ?)')
      .bind('cf-audit-poll', JSON.stringify({ since: held, boundaryIds: [] }))
      .run();
    // 25 malformed entries inside the overlap, all before the held cursor
    const early = Array.from({ length: 25 }, (_, i) =>
      cfEntry({
        id: `early-${i}`,
        actor: 7,
        when: new Date(Date.parse(held) - 50_000 + i * 1000).toISOString(),
      }),
    );
    stubFetch([early]);
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toHaveLength(MAX_UNPARSED_PER_RUN);
    const cursor = await env.DB.prepare(
      "SELECT value FROM poll_cursors WHERE name = 'cf-audit-poll'",
    ).first<{ value: string }>();
    expect((JSON.parse(cursor?.value ?? '{}') as { since: string }).since).toBe(held);
    // The rest, still inside the overlap, are recorded by the next run
    stubFetch([early]);
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toHaveLength(25);
  });

  it('records an entry with valid fields but a missing or empty id as unparsed, never skips it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noId = cfEntry({ when: '2026-06-10T08:01:00Z' });
    delete noId['id'];
    stubFetch([[noId, cfEntry({ id: '', when: '2026-06-10T08:02:00Z' })]]);
    await pollCfAuditLogs(envWith({}));
    const ids = await unparsedIds();
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^unparsed:[0-9a-f]{32}$/);
    const rows = await allAudit();
    expect(rows.map(row => row.path)).toEqual(['unknown/unparsed', 'unknown/unparsed']);
    // Never its content
    expect(JSON.stringify(rows)).not.toContain('admin@example.com');
    // A re-run records neither again
    stubFetch([[noId, cfEntry({ id: '', when: '2026-06-10T08:02:00Z' })]]);
    await pollCfAuditLogs(envWith({}));
    expect(await unparsedIds()).toHaveLength(2);
  });

  it('advances the watermark only from a zoned timestamp, never past the run clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch([
      [
        cfEntry({ id: 'zoned', when: '2026-06-10T08:00:00Z' }),
        // A zone-less time, read in the runtime's zone, must not move it
        cfEntry({ id: 'zoneless', when: '2026-06-10T09:00:00' }),
        // A time after the run's own clock (12:00Z) must not jump it
        cfEntry({ id: 'future', when: '2026-06-11T00:00:00Z' }),
        // Neither on an unparsed entry
        cfEntry({ id: 'unparsed-zoneless', actor: 7, when: '2026-06-10T10:00:00' }),
        cfEntry({ id: 'unparsed-future', actor: 7, when: '2030-01-01T00:00:00Z' }),
      ],
    ]);
    await pollCfAuditLogs(envWith({}));
    // Every entry is still recorded
    expect(await allAudit()).toHaveLength(5);
    const cursor = await env.DB.prepare(
      "SELECT value FROM poll_cursors WHERE name = 'cf-audit-poll'",
    ).first<{ value: string }>();
    expect(JSON.parse(cursor?.value ?? '{}')).toEqual({
      since: '2026-06-10T08:00:00Z',
      boundaryIds: ['zoned'],
    });
    // And the cursor the run wrote reads back: the next run queries from it
    const stub = stubFetch([[]]);
    await pollCfAuditLogs(envWith({}));
    const url = new URL(String(stub.mock.calls[0]?.[0]));
    expect(url.searchParams.get('since')).toBe('2026-06-10T07:59:00.000Z');
  });
});
