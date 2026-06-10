/**
 * Unit tests for the R2 event-notification audit consumer (v1.28.0, ported
 * from Fusang bifrost v1.51.0).
 *
 * Layer 1 of the external R2 operations audit capture
 * (see README.md "External R2 operations audit capture"), hardened per the
 * v1.51.0 review synthesis. Exercises:
 *  - flag gate (R2_EVENT_AUDIT !== 'on' → ackAll, no rows)
 *  - external events recorded as source='r2_event' with the unattributed actor
 *  - event-level idempotency (redelivered fingerprint → no duplicate row, and
 *    a redelivered CORRELATED event never re-surfaces as a false external row)
 *  - correlation dedup via exact path + structured rename/move detail matching
 *    (substring containment removed — cross-object coincidences must NOT match)
 *  - one-event-per-entry consumption slots (external overwrite not swallowed)
 *  - feedback-bucket events always recorded, attributed to the feedback
 *    pipeline when a domain='feedback' row exists in the window
 *  - daily backup system attribution; malformed events; malformed eventTime
 *    degrading to a best-effort external row
 *
 * Real miniflare D1 harness (env.DB) + hand-authored DDL mirroring
 * drizzle/0010 (audit_logs.source, r2_event_correlations, r2_event_seen).
 * Path matching is exact-only in this deployment — dev binds the same actual
 * buckets, so Fusang's shared-dev-bucket key-suffix matching was dropped.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleR2EventBatch, type R2EventMessage } from '../../src/queue/r2-events';
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

const CORRELATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS r2_event_correlations (
    audit_id INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    event_time INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (audit_id, event_kind)
  )`;

const SEEN_DDL = `
  CREATE TABLE IF NOT EXISTS r2_event_seen (
    fingerprint TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`;

interface AuditRow {
  id: number;
  domain: string;
  action: string;
  actor_login: string | null;
  path: string | null;
  details: string | null;
  source: string;
}

function makeEvent(overrides: Partial<R2EventMessage> = {}): R2EventMessage {
  return {
    account: 'test-account',
    action: 'PutObject',
    bucket: 'files',
    object: { key: 'docs/report.pdf', size: 1024, eTag: 'abc123' },
    eventTime: new Date().toISOString(),
    ...overrides,
  };
}

interface FakeMessage {
  body: R2EventMessage;
  acked: boolean;
  retried: boolean;
  ack: () => void;
  retry: () => void;
}

function makeBatch(events: R2EventMessage[]): {
  batch: MessageBatch<R2EventMessage>;
  messages: FakeMessage[];
  ackAllCalled: () => boolean;
} {
  let ackAll = false;
  const messages: FakeMessage[] = events.map(body => {
    const m: FakeMessage = {
      body,
      acked: false,
      retried: false,
      ack: () => {
        m.acked = true;
      },
      retry: () => {
        m.retried = true;
      },
    };
    return m;
  });
  const batch = {
    queue: 'bifrost-r2-events',
    messages,
    ackAll: () => {
      ackAll = true;
    },
    retryAll: () => {},
  } as unknown as MessageBatch<R2EventMessage>;
  return { batch, messages, ackAllCalled: () => ackAll };
}

function envWith(flag: string): Bindings {
  return { ...env, R2_EVENT_AUDIT: flag } as Bindings;
}

async function allAudit(): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, domain, action, actor_login, path, details, source FROM audit_logs ORDER BY id',
  ).all<AuditRow>();
  return results;
}

async function insertBifrostAudit(
  action: string,
  path: string,
  details: Record<string, unknown> | null = null,
  domain = 'storage',
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO audit_logs (domain, action, actor_login, path, details, source)
     VALUES (?1, ?2, 'henry@example.com', ?3, ?4, 'bifrost') RETURNING id`,
  )
    .bind(domain, action, path, details ? JSON.stringify(details) : null)
    .first<{ id: number }>();
  if (!result) throw new Error('insert failed');
  return result.id;
}

describe('handleR2EventBatch', () => {
  beforeAll(async () => {
    await env.DB.prepare(AUDIT_DDL).run();
    await env.DB.prepare(CORRELATIONS_DDL).run();
    await env.DB.prepare(SEEN_DDL).run();
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM audit_logs').run();
    await env.DB.prepare('DELETE FROM r2_event_correlations').run();
    await env.DB.prepare('DELETE FROM r2_event_seen').run();
  });

  describe('flag gate', () => {
    it('acks and discards the whole batch when the flag is off', async () => {
      const { batch, ackAllCalled } = makeBatch([makeEvent()]);
      await handleR2EventBatch(batch, envWith('off'));
      expect(ackAllCalled()).toBe(true);
      expect(await allAudit()).toHaveLength(0);
    });
  });

  describe('external events', () => {
    it('records an unmatched PutObject as external r2_object_create', async () => {
      const { batch, messages } = makeBatch([makeEvent()]);
      await handleR2EventBatch(batch, envWith('on'));

      expect(messages[0].acked).toBe(true);
      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('r2_object_create');
      expect(rows[0].source).toBe('r2_event');
      expect(rows[0].actor_login).toBe('external-unattributed');
      expect(rows[0].path).toBe('files/docs/report.pdf');
      const details = JSON.parse(rows[0].details ?? '{}');
      expect(details.r2Action).toBe('PutObject');
      expect(details.eTag).toBe('abc123');
    });

    it('records an unmatched DeleteObject as external r2_object_delete', async () => {
      const { batch } = makeBatch([makeEvent({ action: 'DeleteObject' })]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('r2_object_delete');
      expect(rows[0].source).toBe('r2_event');
    });

    it('acks structurally malformed messages without recording rows', async () => {
      const malformed = { account: 'x', action: 'PutObject' } as unknown as R2EventMessage;
      const { batch, messages } = makeBatch([malformed]);
      await handleR2EventBatch(batch, envWith('on'));

      expect(messages[0].acked).toBe(true);
      expect(await allAudit()).toHaveLength(0);
    });

    it('degrades a malformed eventTime to a best-effort external row (no retry burn)', async () => {
      const { batch, messages } = makeBatch([makeEvent({ eventTime: 'not-a-timestamp' })]);
      await handleR2EventBatch(batch, envWith('on'));

      expect(messages[0].acked).toBe(true);
      expect(messages[0].retried).toBe(false);
      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_login).toBe('external-unattributed');
      expect(JSON.parse(rows[0].details ?? '{}').malformedEventTime).toBe(true);
    });
  });

  describe('event-level idempotency (at-least-once delivery)', () => {
    it('a redelivered external event does not insert a duplicate row', async () => {
      const event = makeEvent();
      const first = makeBatch([event]);
      await handleR2EventBatch(first.batch, envWith('on'));
      const second = makeBatch([event]); // identical fingerprint = redelivery
      await handleR2EventBatch(second.batch, envWith('on'));

      expect(second.messages[0].acked).toBe(true);
      expect(await allAudit()).toHaveLength(1);
    });

    it('a redelivered CORRELATED event is acked without becoming a false external row', async () => {
      await insertBifrostAudit('r2_upload', 'files/docs/report.pdf', {
        bucket: 'files',
        key: 'docs/report.pdf',
      });
      const event = makeEvent();
      await handleR2EventBatch(makeBatch([event]).batch, envWith('on'));
      // Redelivery: slot already claimed by THIS event — must dedupe on the
      // fingerprint, not fall through to an external insert (the original bug).
      const redelivery = makeBatch([event]);
      await handleR2EventBatch(redelivery.batch, envWith('on'));

      expect(redelivery.messages[0].acked).toBe(true);
      expect(await allAudit()).toHaveLength(1); // just the pre-seeded bifrost row
    });
  });

  describe('correlation dedup', () => {
    it('drops an event explained by a Bifrost upload entry (exact path match)', async () => {
      const auditId = await insertBifrostAudit('r2_upload', 'files/docs/report.pdf', {
        bucket: 'files',
        key: 'docs/report.pdf',
      });

      const { batch, messages } = makeBatch([makeEvent()]);
      await handleR2EventBatch(batch, envWith('on'));

      expect(messages[0].acked).toBe(true);
      expect(await allAudit()).toHaveLength(1);
      const marker = await env.DB.prepare(
        'SELECT audit_id, event_kind FROM r2_event_correlations',
      ).first<{ audit_id: number; event_kind: string }>();
      expect(marker?.audit_id).toBe(auditId);
      expect(marker?.event_kind).toBe('create');
    });

    it('does NOT swallow a distinct second create event for the same key (one slot per entry)', async () => {
      await insertBifrostAudit('r2_upload', 'files/docs/report.pdf', {
        bucket: 'files',
        key: 'docs/report.pdf',
      });

      // Two DISTINCT events on the same key (different eTag — Bifrost's own
      // write + an external overwrite). The second must surface as external.
      const { batch } = makeBatch([
        makeEvent({ object: { key: 'docs/report.pdf', size: 1024, eTag: 'aaa' } }),
        makeEvent({ object: { key: 'docs/report.pdf', size: 2048, eTag: 'bbb' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(2);
      expect(rows[1].action).toBe('r2_object_create');
      expect(rows[1].source).toBe('r2_event');
    });

    it('correlates both halves of a rename via structured detail fields', async () => {
      await insertBifrostAudit('r2_rename', 'files/new-name.pdf', {
        bucket: 'files',
        oldKey: 'old-name.pdf',
        newKey: 'new-name.pdf',
      });

      const { batch } = makeBatch([
        makeEvent({ action: 'CopyObject', object: { key: 'new-name.pdf' } }),
        makeEvent({ action: 'DeleteObject', object: { key: 'old-name.pdf' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      expect(await allAudit()).toHaveLength(1);
      const { results: markers } = await env.DB.prepare(
        'SELECT event_kind FROM r2_event_correlations ORDER BY event_kind',
      ).all<{ event_kind: string }>();
      expect(markers.map(m => m.event_kind)).toEqual(['create', 'delete']);
    });

    it('correlates a move pair (create on destination, delete on source)', async () => {
      await insertBifrostAudit('r2_move', 'files/old.txt', {
        sourceBucket: 'files',
        destinationBucket: 'assets',
        key: 'old.txt',
        destinationKey: 'new.txt',
        size: 10,
      });

      const { batch } = makeBatch([
        makeEvent({ action: 'CopyObject', bucket: 'assets', object: { key: 'new.txt' } }),
        makeEvent({ action: 'DeleteObject', bucket: 'files', object: { key: 'old.txt' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      expect(await allAudit()).toHaveLength(1);
    });

    it('does NOT match a cross-pair coincidence (substring containment removed)', async () => {
      // Move row mentions both 'assets' and 'old.txt' in its details JSON, but
      // the move never touched assets/old.txt — an external delete of that
      // object must surface as external, not be absorbed by the move row.
      await insertBifrostAudit('r2_move', 'files/old.txt', {
        sourceBucket: 'files',
        destinationBucket: 'assets',
        key: 'old.txt',
        destinationKey: 'new.txt',
      });

      const { batch } = makeBatch([
        makeEvent({ action: 'DeleteObject', bucket: 'assets', object: { key: 'old.txt' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(2);
      expect(rows[1].action).toBe('r2_object_delete');
      expect(rows[1].actor_login).toBe('external-unattributed');
    });

    it('does not correlate against an entry outside the time window', async () => {
      const staleTime = Math.floor(Date.now() / 1000) - 3600; // 1h ago
      await env.DB.prepare(
        `INSERT INTO audit_logs (domain, action, actor_login, path, source, created_at)
         VALUES ('storage', 'r2_upload', 'henry@example.com', 'files/docs/report.pdf', 'bifrost', ?1)`,
      )
        .bind(staleTime)
        .run();

      const { batch } = makeBatch([makeEvent()]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(2);
      expect(rows[1].source).toBe('r2_event');
    });
  });

  describe('feedback bucket', () => {
    it('attributes feedback-bucket writes to the pipeline when a feedback row exists', async () => {
      const feedbackId = await insertBifrostAudit(
        'feedback_create',
        '/feedback/F-12',
        { type: 'bug' },
        'feedback',
      );

      const { batch } = makeBatch([
        makeEvent({ bucket: 'bifrost-feedback', object: { key: 'screenshots/f-12-1.png' } }),
        makeEvent({ bucket: 'bifrost-feedback', object: { key: 'screenshots/f-12-2.png' } }),
        makeEvent({ bucket: 'bifrost-feedback', object: { key: 'bundles/f-12.json' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      // 1 feedback row + 3 attributed event rows (always recorded, never absorbed)
      expect(rows).toHaveLength(4);
      for (const row of rows.slice(1)) {
        expect(row.actor_login).toBe('bifrost-feedback-pipeline');
        expect(row.source).toBe('r2_event');
        expect(JSON.parse(row.details ?? '{}').correlatedFeedbackAuditId).toBe(feedbackId);
      }
    });

    it('flags feedback-bucket writes as external when no feedback activity exists', async () => {
      const { batch } = makeBatch([
        makeEvent({ bucket: 'bifrost-feedback', object: { key: 'implant.bin' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_login).toBe('external-unattributed');
    });
  });

  describe('system attribution', () => {
    it('attributes daily backup writes to the scheduled-backup system actor', async () => {
      const { batch } = makeBatch([
        makeEvent({
          bucket: 'bifrost-backups',
          object: { key: 'daily/20260610/routes.ndjson.gz', size: 2048 },
        }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_login).toBe('bifrost-scheduled-backup');
      expect(rows[0].source).toBe('r2_event');
      expect(rows[0].action).toBe('r2_object_create');
    });

    it('treats non-daily writes to the backups bucket as external', async () => {
      const { batch } = makeBatch([
        makeEvent({ bucket: 'bifrost-backups', object: { key: 'manual-dump.sql' } }),
      ]);
      await handleR2EventBatch(batch, envWith('on'));

      const rows = await allAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_login).toBe('external-unattributed');
    });
  });
});
