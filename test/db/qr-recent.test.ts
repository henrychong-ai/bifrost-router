/**
 * A new QR code is listed before KV listing catches up (v1.40.0), recorded as
 * D1 rows since v1.41.0 (the shared KV key could drop a concurrent create):
 * one row per INCARNATION, `(domain, id, created_at)`, so no write is ever
 * ordered by a clock and the best-effort writes may land in any order. KV's
 * list lag is simulated by a namespace whose list hides chosen keys while get
 * still reads them, as at an edge whose listing has not caught up. The table
 * comes from the REAL migration.
 */
/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */
import { env, SELF } from 'cloudflare:test';
import { type QRCode, QRCodeSchema, QRDesignSchema } from '@bifrost/shared';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import migration0013 from '../../drizzle/0013_qr_recent.sql?raw';
import {
  awaitRecentQrs,
  forgetRecentQr,
  noteRecentQr,
  QR_RECENT_MAX,
  QR_RECENT_PRUNE_BATCH,
  QR_RECENT_READ_TIMEOUT_MS,
  QR_RECENT_SKEW_MARGIN_MS,
  QR_RECENT_WINDOW_MS,
  recentQrs,
} from '../../src/db/qr-recent';
import { qrRecent } from '../../src/db/schema';
import { listQRs, putQR } from '../../src/kv/qr';
import { isRouteKey, qrDomainPrefix, qrKey } from '../../src/kv/schema';

const DOMAIN = 'links.example.com';
const OTHER = 'secondary.example.net';
const ADMIN_HOST = 'example.com';
const API_KEY = 'test-api-key-12345'; // gitleaks:allow
const HEADERS = { 'X-Admin-Key': API_KEY, 'Content-Type': 'application/json' };
const API = `https://${ADMIN_HOST}/api/qr`;
/** The v1.40.0 KV record of a domain's recent writes, no longer read or written. */
const OLD_RECENT_KEY = `qr-recent:${DOMAIN}`;
/** Rows noted longer than this before `now` are outside the read and may be pruned. */
const REACH_MS = QR_RECENT_WINDOW_MS + QR_RECENT_SKEW_MARGIN_MS;

/** The ids `recentQrs` offers, oldest noted first. */
async function recentQrIds(db: D1Database, domain: string, now?: number): Promise<string[]> {
  return (await recentQrs(db, domain, now)).map(row => row.id);
}

function makeQR(id: string, updatedAt = 2, createdAt = 1): QRCode {
  return QRCodeSchema.parse({
    id,
    domain: DOMAIN,
    type: 'url',
    payload: { url: 'https://example.com' },
    design: QRDesignSchema.parse({}),
    createdAt,
    updatedAt,
    createdBy: 'test-user',
  });
}

/** Split a migration file into executable statements (comments stripped). */
function migrationStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationStatements(migration0013)) {
    await env.DB.prepare(statement).run();
  }
}

/** env.ROUTES whose list() leaves out `hidden` keys (the list lag). */
function laggingKv(hidden: Set<string>): KVNamespace {
  return new Proxy(env.ROUTES, {
    get(target, property) {
      if (property === 'list') {
        return async (options?: KVNamespaceListOptions) => {
          const result = await target.list(options);
          return { ...result, keys: result.keys.filter(key => !hidden.has(key.name)) };
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A D1 binding whose every statement fails, as when D1 is down. */
const failingDb = {
  batch: async () => {
    throw new TypeError('D1 down');
  },
  prepare: () => ({
    bind: () => ({
      run: async () => {
        throw new TypeError('D1 down');
      },
      all: async () => {
        throw new TypeError('D1 down');
      },
    }),
  }),
} as unknown as D1Database;

async function rowCount(domain = DOMAIN): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM qr_recent WHERE domain = ?')
    .bind(domain)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Insert a row directly: noted at its incarnation unless told otherwise. */
async function insertRow(
  domain: string,
  id: string,
  createdAt: unknown,
  notedAt: unknown = createdAt,
  deleted = 0,
) {
  await env.DB.prepare(
    'INSERT INTO qr_recent (domain, id, created_at, deleted, noted_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(domain, id, createdAt, deleted, notedAt)
    .run();
}

/** Every row of `id`, by incarnation. */
async function stored(id: string, domain = DOMAIN) {
  const rows = await env.DB.prepare(
    'SELECT created_at, deleted, noted_at FROM qr_recent WHERE domain = ? AND id = ? ORDER BY created_at',
  )
    .bind(domain, id)
    .all<{ created_at: number; deleted: number; noted_at: number }>();
  return rows.results;
}

/** The incarnations of `id` and whether each is deleted, by incarnation. */
async function incarnations(id: string, domain = DOMAIN) {
  return (await stored(id, domain)).map(row => [row.created_at, row.deleted]);
}

/** A Proxy over env.DB that overrides `overrides` and binds everything else. */
function dbWith(overrides: Partial<Record<keyof D1Database, unknown>>): D1Database {
  return new Proxy(env.DB, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof D1Database];
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * env.DB, recording each statement's SQL in `log` as it is PREPARED (so the
 * order against other calls shows when a read started, not when it ended).
 */
function recordingDb(log: string[]): D1Database {
  return dbWith({
    prepare: (sql: string) => {
      log.push(sql);
      return env.DB.prepare(sql);
    },
  });
}

/** env.DB counting batches and lone runs; `breakPrune` makes the prune fail in D1 itself. */
function batchingDb(breakPrune: boolean) {
  const counts = { batch: 0, run: 0 };
  const db = dbWith({
    batch: (statements: D1PreparedStatement[]) => {
      counts.batch += 1;
      return env.DB.batch(statements);
    },
    prepare: (sql: string) => {
      const prepared = env.DB.prepare(
        breakPrune && sql.startsWith('DELETE FROM qr_recent')
          ? sql.replace('DELETE FROM qr_recent', 'DELETE FROM qr_recent_missing')
          : sql,
      );
      return new Proxy(prepared, {
        get(statement, key) {
          const value: unknown = Reflect.get(statement, key);
          if (key !== 'bind') return typeof value === 'function' ? value.bind(statement) : value;
          return (...args: unknown[]) => {
            const bound = statement.bind(...args);
            const run = bound.run.bind(bound);
            // A lone run is counted; the batch takes the bound statement as it is
            Object.defineProperty(bound, 'run', {
              value: () => {
                counts.run += 1;
                return run();
              },
            });
            return bound;
          };
        },
      });
    },
  });
  return { db, counts };
}

/** env.DB whose batch answers `results` without running anything. */
const answering = (results: unknown[]) => dbWith({ batch: async () => results });

/** env.DB whose batch throws `error`. */
const throwing = (error: unknown) =>
  dbWith({
    batch: async () => {
      throw error;
    },
  });

async function createThroughApi(id: string): Promise<number> {
  const res = await SELF.fetch(`${API}?domain=${DOMAIN}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ id, type: 'url', payload: { url: 'https://example.com' } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: QRCode }).data.createdAt;
}

async function deleteThroughApi(id: string): Promise<void> {
  const res = await SELF.fetch(`${API}/${id}?domain=${DOMAIN}`, {
    method: 'DELETE',
    headers: HEADERS,
  });
  expect(res.status).toBe(200);
}

async function clear() {
  for (const domain of [DOMAIN, OTHER]) {
    for (const key of (await env.ROUTES.list({ prefix: qrDomainPrefix(domain) })).keys) {
      await env.ROUTES.delete(key.name);
    }
  }
  await env.ROUTES.delete(OLD_RECENT_KEY);
  await env.DB.prepare('DELETE FROM qr_recent').run();
}

beforeAll(applyMigration);
beforeEach(clear);
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await clear();
});

describe('recently created QR codes (v1.40.0; D1 rows per incarnation since v1.41.0)', () => {
  it('migration 0013 is idempotent and keys the table by domain, id and incarnation', async () => {
    await applyMigration();
    const info = await env.DB.prepare(
      "SELECT name, pk, `notnull` AS required, dflt_value AS fallback FROM pragma_table_info('qr_recent') ORDER BY cid",
    ).all<{ name: string; pk: number; required: number; fallback: string | null }>();
    expect(info.results).toEqual([
      { name: 'domain', pk: 1, required: 1, fallback: null },
      { name: 'id', pk: 2, required: 1, fallback: null },
      { name: 'created_at', pk: 3, required: 1, fallback: null },
      { name: 'deleted', pk: 0, required: 1, fallback: '0' },
      { name: 'noted_at', pk: 0, required: 1, fallback: null },
    ]);
    const index = await env.DB.prepare(
      "SELECT name FROM pragma_index_list('qr_recent') WHERE origin = 'c'",
    ).all<{ name: string }>();
    expect(index.results.map(row => row.name)).toEqual(['idx_qr_recent_domain_noted']);
  });

  it('the Drizzle qrRecent table declares the same key and index as migration 0013', async () => {
    const config = getTableConfig(qrRecent);
    const declared = config.indexes.map(entry => ({
      name: entry.config.name,
      columns: entry.config.columns.map(column => (column as { name: string }).name),
    }));
    const created = await env.DB.prepare(
      "SELECT name FROM pragma_index_list('qr_recent') WHERE origin = 'c'",
    ).all<{ name: string }>();
    const migrated = [];
    for (const { name } of created.results) {
      const columns = await env.DB.prepare(
        `SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`,
      ).all<{ name: string }>();
      migrated.push({ name, columns: columns.results.map(column => column.name) });
    }
    expect(declared).toEqual(migrated);
    expect(declared).toEqual([
      { name: 'idx_qr_recent_domain_noted', columns: ['domain', 'noted_at'] },
    ]);
    expect(config.primaryKeys[0]?.columns.map(column => column.name)).toEqual([
      'domain',
      'id',
      'created_at',
    ]);
  });

  it('lists a code its listing does not show yet, read by its own key', async () => {
    const now = Date.now();
    await putQR(env.ROUTES, makeQR('listed', 1));
    await putQR(env.ROUTES, makeQR('fresh', now, now));
    await noteRecentQr(env.DB, DOMAIN, 'fresh', now);
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'fresh')]));

    const { items, total } = await listQRs(kv, DOMAIN, { offset: 0 }, env.DB);
    expect(items.map(item => item.id)).toEqual(['fresh', 'listed']);
    expect(total).toBe(2);
    // Without the record nothing is merged
    expect((await listQRs(kv, DOMAIN)).items.map(item => item.id)).toEqual(['listed']);
  });

  it('lists a code once when the listing already shows it', async () => {
    await putQR(env.ROUTES, makeQR('fresh'));
    await noteRecentQr(env.DB, DOMAIN, 'fresh', 1);
    const { items } = await listQRs(env.ROUTES, DOMAIN, { offset: 0 }, env.DB);
    expect(items.map(item => item.id)).toEqual(['fresh']);
  });

  // v1.38.0 rule, as v1.40.x merged it: a record that cannot be read is listed
  // as a minimal row with Delete. It names no createdAt, so it matches no
  // incarnation; it is listed whatever the live row's incarnation, once
  it('lists a recent unreadable record as its minimal row, once', async () => {
    await env.ROUTES.put(qrKey(DOMAIN, 'broken'), '{not json');
    await noteRecentQr(env.DB, DOMAIN, 'broken', Date.now());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'broken')]));
    const row = { domain: DOMAIN, id: 'broken', invalid: true };
    expect(await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).toEqual({ items: [row], total: 1 });
    expect(await listQRs(env.ROUTES, DOMAIN, { offset: 0 }, env.DB)).toEqual({
      items: [row],
      total: 1,
    });
    // It matches a search by its id only, and no type filter, as a listed one does
    expect((await listQRs(kv, DOMAIN, { offset: 0, search: 'zzz' }, env.DB)).items).toEqual([]);
    expect((await listQRs(kv, DOMAIN, { offset: 0, type: 'url' }, env.DB)).items).toEqual([]);
  });

  // A row is a hint that an id may be missing from KV's listing, never the
  // incarnation to show. A KV location can still serve a deleted incarnation
  // (KV converges in about a minute), or a newer one whose own create write
  // has not landed yet; neither is merged
  it('merges a recent id only for a live incarnation KV serves', async () => {
    const now = Date.now();
    const A = now - 20;
    const B = now - 10;
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'code')]));
    const listedIds = async () =>
      (await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).items.map(item => item.id);

    // Re-created as B (recorded) while this location's KV still serves deleted A
    await putQR(env.ROUTES, makeQR('code', A, A));
    await noteRecentQr(env.DB, DOMAIN, 'code', A, now);
    await forgetRecentQr(env.DB, DOMAIN, 'code', A, now);
    await noteRecentQr(env.DB, DOMAIN, 'code', B, now);
    expect(await recentQrs(env.DB, DOMAIN, now)).toEqual([{ id: 'code', createdAt: B }]);
    expect(await listedIds()).toEqual([]);

    // KV serves B while only A's row is recorded (B's write not landed yet)
    await env.DB.prepare('DELETE FROM qr_recent').run();
    await noteRecentQr(env.DB, DOMAIN, 'code', A, now);
    await putQR(env.ROUTES, makeQR('code', B, B));
    expect(await listedIds()).toEqual([]);

    // Once B's own row lands, B is merged, beside A's still-live row
    await noteRecentQr(env.DB, DOMAIN, 'code', B, now);
    const { items, total } = await listQRs(kv, DOMAIN, { offset: 0 }, env.DB);
    expect(items).toEqual([makeQR('code', B, B)]);
    expect(total).toBe(1);
  });

  // The root cause this release removes: isolates' clocks disagree, so a code
  // re-created on an isolate whose clock runs BEHIND the deleted one's has an
  // earlier createdAt. Another incarnation is another row, so it is listed
  describe('a re-create whose clock runs behind the deleted incarnation’s', () => {
    const now = Date.now();
    const A = now - 10;
    for (const [label, B] of [
      ['behind', now - 5_000],
      ['ahead', now + 5_000],
    ] as const) {
      const writes = {
        'create A': () => noteRecentQr(env.DB, DOMAIN, 'code', A, now),
        'delete A': () => forgetRecentQr(env.DB, DOMAIN, 'code', A, now),
        'create B': () => noteRecentQr(env.DB, DOMAIN, 'code', B, now),
      };
      type Write = keyof typeof writes;
      const names = Object.keys(writes) as Write[];
      const orders: Write[][] = names.flatMap(first =>
        names
          .filter(second => second !== first)
          .map(second => [
            first,
            second,
            names.find(name => name !== first && name !== second) ?? first,
          ]),
      );
      it.each(orders)(`B ${label}: %s, %s, %s: B listed, A never`, async (...order) => {
        for (const name of order) await writes[name]();
        expect(await recentQrs(env.DB, DOMAIN, now)).toEqual([{ id: 'code', createdAt: B }]);
        // KV serving deleted A (a stale location) merges nothing; serving B merges B
        const kv = laggingKv(new Set([qrKey(DOMAIN, 'code')]));
        await putQR(env.ROUTES, makeQR('code', A, A));
        expect((await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).items).toEqual([]);
        await putQR(env.ROUTES, makeQR('code', B, B));
        expect((await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).items).toEqual([
          makeQR('code', B, B),
        ]);
        // Replaying A's writes, in either order, changes nothing
        await writes['create A']();
        await writes['delete A']();
        expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['code']);
        // Deleting B hides it too, and a delayed create write never brings either back
        await forgetRecentQr(env.DB, DOMAIN, 'code', B, now);
        await writes['create A']();
        await writes['create B']();
        expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual([]);
        expect(await incarnations('code')).toEqual(
          [
            [A, 1],
            [B, 1],
          ].toSorted((x, y) => (x[0] ?? 0) - (y[0] ?? 0)),
        );
      });
    }
  });

  it('a delete landing before its create write still wins, in both orders', async () => {
    const now = Date.now();
    // Delete first: the row is inserted already deleted; the late create changes nothing
    await forgetRecentQr(env.DB, DOMAIN, 'late', now - 5, now);
    await noteRecentQr(env.DB, DOMAIN, 'late', now - 5, now);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual([]);
    expect(await incarnations('late')).toEqual([[now - 5, 1]]);
    // Create first: the delete marks the row
    await noteRecentQr(env.DB, DOMAIN, 'early', now - 5, now);
    await forgetRecentQr(env.DB, DOMAIN, 'early', now - 5, now);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual([]);
    expect(await incarnations('early')).toEqual([[now - 5, 1]]);
    // Another incarnation, even one stamped a millisecond EARLIER, is listed
    await noteRecentQr(env.DB, DOMAIN, 'late', now - 6, now);
    expect(await recentQrs(env.DB, DOMAIN, now)).toEqual([{ id: 'late', createdAt: now - 6 }]);
  });

  // v1.41.0 review: a first-page-only merge made a later page's offset count
  // a different set of rows than the first page's. Every page merges again
  it('merges on every page: no record skipped, the same total on each', async () => {
    const now = Date.now();
    for (const [id, updatedAt] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      await putQR(env.ROUTES, makeQR(id, updatedAt));
    }
    await putQR(env.ROUTES, makeQR('fresh', now, now));
    await noteRecentQr(env.DB, DOMAIN, 'fresh', now);
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'fresh')]));
    const pages = [];
    for (const offset of [0, 2]) {
      pages.push(await listQRs(kv, DOMAIN, { offset, limit: 2 }, env.DB));
    }
    expect(pages.map(page => page.items.map(item => item.id))).toEqual([
      ['fresh', 'c'],
      ['b', 'a'],
    ]);
    expect(pages.map(page => page.total)).toEqual([4, 4]);
  });

  it('leaves out a deleted incarnation, a row noted outside the window, and other domains', async () => {
    const now = Date.now();
    await noteRecentQr(env.DB, DOMAIN, 'gone', 7, now);
    await forgetRecentQr(env.DB, DOMAIN, 'gone', 7, 7);
    await noteRecentQr(env.DB, DOMAIN, 'old', 1, now - REACH_MS - 1);
    await noteRecentQr(env.DB, DOMAIN, 'edge', 2, now - REACH_MS);
    await noteRecentQr(env.DB, DOMAIN, 'live', 3, now);
    await noteRecentQr(env.DB, OTHER, 'elsewhere', 4, now);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['edge', 'live']);
  });

  // The window reads `noted_at`, the writer's clock; the incarnation is never
  // compared with any clock. The read has no upper bound and reaches the skew
  // margin past the window
  it('reads a row noted by a clock ahead of this one, and up to the skew margin past the window', async () => {
    const now = Date.now();
    await noteRecentQr(env.DB, DOMAIN, 'ahead', now + 10_000, now + 10_000);
    await noteRecentQr(env.DB, DOMAIN, 'behind', 1, now - QR_RECENT_WINDOW_MS - 1);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['behind', 'ahead']);
    // A code created on an isolate whose clock runs ahead is merged by its own incarnation
    await putQR(env.ROUTES, makeQR('ahead', now + 10_000, now + 10_000));
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'ahead')]));
    expect((await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).items.map(item => item.id)).toEqual([
      'ahead',
    ]);
  });

  it('applies the list filters to a recent code', async () => {
    const now = Date.now();
    await putQR(env.ROUTES, makeQR('fresh', now, now));
    await noteRecentQr(env.DB, DOMAIN, 'fresh', now);
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'fresh')]));
    expect((await listQRs(kv, DOMAIN, { offset: 0, type: 'wifi' }, env.DB)).items).toEqual([]);
    expect((await listQRs(kv, DOMAIN, { offset: 0, search: 'fresh' }, env.DB)).items).toHaveLength(
      1,
    );
  });

  // The v1.40.0 TODO: two creates at the same moment each read-modified-wrote
  // one shared KV key, so one id could be lost
  it('keeps every code of concurrent creates, even in the same millisecond', async () => {
    const now = Date.now();
    await Promise.all(['a', 'b', 'c', 'd'].map(id => noteRecentQr(env.DB, DOMAIN, id, now, now)));
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps both codes of two concurrent creates through the API', async () => {
    await Promise.all(['first', 'second'].map(id => createThroughApi(id)));
    // Written after the answer
    await expect
      .poll(async () => (await recentQrIds(env.DB, DOMAIN)).toSorted())
      .toEqual(['first', 'second']);
    // Both listed while KV listing has caught up with neither
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'first'), qrKey(DOMAIN, 'second')]));
    const { items } = await listQRs(kv, DOMAIN, { offset: 0 }, env.DB);
    expect(items.map(item => item.id).toSorted()).toEqual(['first', 'second']);
  });

  it('a create written twice keeps one row, noted at its first write', async () => {
    const now = Date.now();
    await noteRecentQr(env.DB, DOMAIN, 'same', now, now);
    await noteRecentQr(env.DB, DOMAIN, 'same', now, now + 50);
    expect(await stored('same')).toEqual([{ created_at: now, deleted: 0, noted_at: now }]);
  });

  it('merges the newest noted rows only, oldest first', async () => {
    const now = Date.now();
    for (let index = 0; index < QR_RECENT_MAX + 5; index += 1) {
      await insertRow(DOMAIN, `id-${String(index).padStart(3, '0')}`, index, now - 1000 + index);
    }
    const ids = await recentQrIds(env.DB, DOMAIN, now);
    expect(ids).toHaveLength(QR_RECENT_MAX);
    expect(ids[0]).toBe('id-005');
    expect(ids.at(-1)).toBe(`id-${String(QR_RECENT_MAX + 4).padStart(3, '0')}`);
  });

  it('a create prunes rows of its domain noted before the window, a bounded batch at a time', async () => {
    const now = Date.now();
    const expired = QR_RECENT_PRUNE_BATCH + 20;
    for (let index = 0; index < expired; index += 1) {
      await insertRow(DOMAIN, `old-${index}`, index, now - REACH_MS - 1 - index);
    }
    // A deleted row is pruned by its noted time like any other
    await insertRow(DOMAIN, 'old-tombstone', 1, now - REACH_MS - 1, 1);
    await insertRow(DOMAIN, 'tombstone', 1, now - 10, 1);
    // Past the window but inside the skew margin: not yet pruned
    await insertRow(DOMAIN, 'margin', 1, now - QR_RECENT_WINDOW_MS - 1);
    await insertRow(DOMAIN, 'fresh', 1, now);
    await insertRow(OTHER, 'old-elsewhere', 1, now - REACH_MS - 1);
    const total = expired + 4;

    // A listing writes nothing
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['margin', 'fresh']);
    expect(await rowCount()).toBe(total);

    // One batch per create (its own row added)
    await noteRecentQr(env.DB, DOMAIN, 'new', now, now);
    expect(await rowCount()).toBe(total + 1 - QR_RECENT_PRUNE_BATCH);
    await noteRecentQr(env.DB, DOMAIN, 'newer', now + 1, now);
    expect(await rowCount()).toBe(5);
    expect(await stored('tombstone')).toHaveLength(1);
    expect(await stored('margin')).toHaveLength(1);
    expect(await stored('old-tombstone')).toEqual([]);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['margin', 'fresh', 'new', 'newer']);
    // Another domain's rows are its own writes' to prune
    expect(await rowCount(OTHER)).toBe(1);
  });

  // v1.41.0 review: a domain that only ever sees deletes must not grow
  it('a delete prunes too, so a delete-only domain stays bounded', async () => {
    const now = Date.now();
    for (let index = 0; index < QR_RECENT_PRUNE_BATCH + 10; index += 1) {
      await insertRow(DOMAIN, `old-${index}`, index, now - REACH_MS - 1, 1);
    }
    await forgetRecentQr(env.DB, DOMAIN, 'gone', now, now);
    expect(await rowCount()).toBe(10 + 1);
    await forgetRecentQr(env.DB, DOMAIN, 'gone-too', now, now);
    expect(await rowCount()).toBe(2);
    // Every delete of a fresh incarnation leaves one row, pruned once past the window
    await forgetRecentQr(env.DB, DOMAIN, 'later', now + REACH_MS + 1, now + REACH_MS + 1);
    expect(await recentQrIds(env.DB, DOMAIN, now + REACH_MS + 1)).toEqual([]);
    expect((await stored('later')).length + (await stored('gone')).length).toBe(1);
  });

  // v1.41.0 review: whether an incarnation is "old" would compare the
  // creating isolate's clock with the deleting one's, and no clock orders two
  // writes, so a delete always writes its row, noted at its own `now`
  it('a delete of an incarnation created long before the window still writes its deleted row', async () => {
    const now = Date.now();
    const ancient = now - 10 * REACH_MS;
    await insertRow(DOMAIN, 'expired', 1, now - REACH_MS - 1);
    await forgetRecentQr(env.DB, DOMAIN, 'ancient', ancient, now);
    expect(await stored('ancient')).toEqual([{ created_at: ancient, deleted: 1, noted_at: now }]);
    // The same batch pruned the expired row; the deleted row goes once past the window
    expect(await rowCount()).toBe(1);
    await noteRecentQr(env.DB, DOMAIN, 'next', now + REACH_MS + 1, now + REACH_MS + 1);
    expect(await stored('ancient')).toEqual([]);
  });

  it('a listing writes nothing to the record, and starts its read alongside the KV listing', async () => {
    await putQR(env.ROUTES, makeQR('listed', 1));
    await insertRow(DOMAIN, 'expired', 1, Date.now() - REACH_MS - 10);
    const log: string[] = [];
    const kv = new Proxy(env.ROUTES, {
      get(target, property) {
        if (property === 'list') {
          return (options?: KVNamespaceListOptions) => {
            log.push('kv.list');
            return target.list(options);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { items } = await listQRs(kv, DOMAIN, { offset: 0 }, recordingDb(log));
    expect(items.map(item => item.id)).toEqual(['listed']);
    // The D1 read was started before the KV listing loop, not after it
    expect(log[0]).toMatch(/^SELECT id, created_at FROM qr_recent/);
    expect(log[1]).toBe('kv.list');
    // ...and nothing but that read
    expect(log.filter(entry => entry !== 'kv.list')).toHaveLength(1);
    expect(await rowCount()).toBe(1);
    // A later page reads it too
    log.length = 0;
    await listQRs(kv, DOMAIN, { offset: 5, limit: 5 }, recordingDb(log));
    expect(log.filter(entry => entry !== 'kv.list')).toHaveLength(1);
  });

  describe('the listing’s wait for the read is bounded (v1.41.0 review)', () => {
    /** A D1 binding whose read never answers, as when D1 hangs. */
    const hangingDb = dbWith({
      prepare: () => ({
        bind: () => ({ all: () => new Promise<never>(() => undefined) }),
      }),
    });

    it('a read that has not answered in time is no recent codes, logged once as a timeout', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await awaitRecentQrs(new Promise<never>(() => undefined), 5)).toEqual([]);
      expect(warn.mock.calls).toEqual([['[QR] Recent creates could not be read: timeout']]);
    });

    it('a read that answers first is returned, and its timer is cleared (no timeout logged later)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = [{ id: 'a', createdAt: 1 }];
      expect(await awaitRecentQrs(Promise.resolve(rows), 5)).toBe(rows);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(warn).not.toHaveBeenCalled();
    });

    it('a QR listing with a hung D1 answers from KV after the timeout', async () => {
      expect(QR_RECENT_READ_TIMEOUT_MS).toBe(300);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await putQR(env.ROUTES, makeQR('listed'));
      const started = Date.now();
      const { items } = await listQRs(env.ROUTES, DOMAIN, { offset: 0 }, hangingDb);
      expect(items.map(item => item.id)).toEqual(['listed']);
      expect(Date.now() - started).toBeLessThan(QR_RECENT_READ_TIMEOUT_MS + 2_000);
      expect(warn.mock.calls).toEqual([['[QR] Recent creates could not be read: timeout']]);
    });
  });

  it('skips a row that does not fit the schema, logging a count only', async () => {
    const now = Date.now();
    await insertRow(DOMAIN, 'good', 1, now);
    // An empty id: a row no create writes
    await insertRow(DOMAIN, '', 1, now - 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['good']);
    expect(warn.mock.calls).toEqual([['[QR] Recent create rows skipped as unreadable: 1']]);
  });

  it('reads a failing D1 as no recent codes and never throws, logging the error class only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    expect(await recentQrIds(failingDb, DOMAIN)).toEqual([]);
    await expect(noteRecentQr(failingDb, DOMAIN, 'x', now)).resolves.toBeUndefined();
    await expect(forgetRecentQr(failingDb, DOMAIN, 'x', now)).resolves.toBeUndefined();
    // read + note (its batch, then its write alone) + forget (the same)
    expect(warn.mock.calls).toEqual([
      ['[QR] Recent creates could not be read: TypeError'],
      ['[QR] Recent create and prune failed together, writing the create alone: TypeError'],
      ['[QR] Recent create could not be recorded: TypeError'],
      ['[QR] Recent delete and prune failed together, writing the delete alone: TypeError'],
      ['[QR] Recent delete could not be recorded: TypeError'],
    ]);
    // A listing still answers
    await putQR(env.ROUTES, makeQR('listed'));
    expect(
      (await listQRs(env.ROUTES, DOMAIN, { offset: 0 }, failingDb)).items.map(item => item.id),
    ).toEqual(['listed']);
  });

  // The merge is best effort: a recent code whose own read fails is left
  // out, and the listing still answers
  it('skips a recent code whose read fails, logging the error class only', async () => {
    await putQR(env.ROUTES, makeQR('listed', 1));
    await noteRecentQr(env.DB, DOMAIN, 'flaky', Date.now());
    const flakyKey = qrKey(DOMAIN, 'flaky');
    const lagging = laggingKv(new Set([flakyKey]));
    const kv = new Proxy(lagging, {
      get(target, property) {
        if (property === 'get') {
          return async (key: string, ...rest: unknown[]) => {
            if (key === flakyKey) throw new Error(`KV GET failed: ${key}`);
            return Reflect.apply(target.get, target, [key, ...rest]);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { items } = await listQRs(kv, DOMAIN, { offset: 0 }, env.DB);
    expect(items.map(item => item.id)).toEqual(['listed']);
    expect(warn.mock.calls).toEqual([['[QR] A recent code could not be read: Error']]);
  });

  // The v1.40.0 KV record is no longer read or written; it expires on its own
  // and was never listed or backed up
  it('ignores the old KV record and writes none', async () => {
    await putQR(env.ROUTES, makeQR('kv-only'));
    await env.ROUTES.put(OLD_RECENT_KEY, JSON.stringify([{ id: 'kv-only', at: Date.now() }]));
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'kv-only')]));
    expect((await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).items).toEqual([]);
    await env.ROUTES.delete(OLD_RECENT_KEY);
    await createThroughApi('new');
    await expect.poll(() => recentQrIds(env.DB, DOMAIN)).toEqual(['new']);
    expect(await env.ROUTES.get(OLD_RECENT_KEY)).toBeNull();
    expect(OLD_RECENT_KEY.startsWith(qrDomainPrefix(DOMAIN))).toBe(false);
    expect(isRouteKey(OLD_RECENT_KEY)).toBe(false);
  });

  it('records a code created through the API at its own createdAt, and never an update', async () => {
    const createdAt = await createThroughApi('via-api');
    await expect.poll(() => recentQrIds(env.DB, DOMAIN)).toEqual(['via-api']);
    expect(await incarnations('via-api')).toEqual([[createdAt, 0]]);
    await env.DB.prepare('DELETE FROM qr_recent').run();
    const updated = await SELF.fetch(`${API}/via-api?domain=${DOMAIN}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({ description: 'edited' }),
    });
    expect(updated.status).toBe(200);
    // A readable delete after it: once its tombstone lands, any work the
    // update started has run too
    await deleteThroughApi('via-api');
    await expect.poll(() => incarnations('via-api')).toEqual([[createdAt, 1]]);
    expect(await rowCount()).toBe(1);
  });

  // A deleted code leaves the recent record, so a recent row cannot bring it
  // back while another location's KV still serves it. The delete names the
  // incarnation read before the KV delete
  it('hides a code deleted through the API, at its own incarnation', async () => {
    const createdAt: Record<string, number> = {};
    for (const id of ['keep', 'gone']) {
      createdAt[id] = await createThroughApi(id);
      await expect.poll(async () => (await recentQrIds(env.DB, DOMAIN)).includes(id)).toBe(true);
    }
    await deleteThroughApi('gone');
    await expect.poll(() => recentQrIds(env.DB, DOMAIN)).toEqual(['keep']);
    expect(await incarnations('gone')).toEqual([[createdAt['gone'], 1]]);
  });

  // v1.41.0 review: an unreadable record names no incarnation, so its delete
  // writes nothing to the recent record (no request-time clock stands in)
  it('an unreadable record deleted through the API writes no recent row', async () => {
    const now = Date.now();
    await env.ROUTES.put(qrKey(DOMAIN, 'unreadable'), '{not json');
    await noteRecentQr(env.DB, DOMAIN, 'unreadable', now - 1000, now);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deleteThroughApi('unreadable');
    // A readable delete after it: once its row lands, the unreadable delete's
    // own after-answer work (started first) has run too
    await putQR(env.ROUTES, makeQR('readable', now, now));
    await deleteThroughApi('readable');
    await expect.poll(() => incarnations('readable')).toEqual([[now, 1]]);
    expect(await stored('unreadable')).toEqual([
      { created_at: now - 1000, deleted: 0, noted_at: now },
    ]);
    // KV no longer holds it here, so the live row merges nothing
    expect((await listQRs(env.ROUTES, DOMAIN, { offset: 0 }, env.DB)).items).toEqual([]);
    warn.mockRestore();
  });

  // A missing table fails the lone write too, so it is logged once and not
  // retried; any other batch failure is retried alone (the prune-failure
  // test below: a missing `qr_recent_missing` is not it)
  it('a missing qr_recent table is logged once per write and the write is not retried', async () => {
    await env.DB.prepare('DROP TABLE qr_recent').run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db, counts } = batchingDb(false);
      const now = Date.now();
      await expect(noteRecentQr(db, DOMAIN, 'new', now)).resolves.toBeUndefined();
      await expect(forgetRecentQr(db, DOMAIN, 'new', now)).resolves.toBeUndefined();
      expect(counts).toEqual({ batch: 2, run: 0 });
      expect(warn.mock.calls).toEqual([
        ['[QR] Recent create not recorded: table qr_recent is missing'],
        ['[QR] Recent delete not recorded: table qr_recent is missing'],
      ]);
      // A listing with no table is no recent codes, and still answers; the
      // read path, which every listing takes, names it once per isolate
      warn.mockClear();
      await putQR(env.ROUTES, makeQR('listed'));
      for (let listing = 0; listing < 3; listing += 1) {
        expect(
          (await listQRs(env.ROUTES, DOMAIN, { offset: 0 }, env.DB)).items.map(item => item.id),
        ).toEqual(['listed']);
      }
      expect(warn.mock.calls).toEqual([
        ['[QR] Recent creates not read: table qr_recent is missing'],
      ]);
    } finally {
      await applyMigration();
    }
  });

  it('a missing table is recognised through an error cause, and only by its exact name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    const wrapped = new Error('D1_ERROR', {
      cause: new Error('no such table: qr_recent: SQLITE_ERROR'),
    });
    await noteRecentQr(throwing(wrapped), DOMAIN, 'wrapped', now, now);
    expect(await stored('wrapped')).toEqual([]);
    await noteRecentQr(
      throwing(new Error('no such table: qr_recent_other')),
      DOMAIN,
      'retried',
      now,
      now,
    );
    expect(await incarnations('retried')).toEqual([[now, 0]]);
    await noteRecentQr(throwing('not an error'), DOMAIN, 'odd', now, now);
    expect(await incarnations('odd')).toEqual([[now, 0]]);
    expect(warn.mock.calls).toEqual([
      ['[QR] Recent create not recorded: table qr_recent is missing'],
      ['[QR] Recent create and prune failed together, writing the create alone: Error'],
      ['[QR] Recent create and prune failed together, writing the create alone: string'],
    ]);
  });

  // The row and the prune go in one batch, which D1 runs as one transaction;
  // a prune that fails rolls the row back with it, so the row is written
  // again on its own
  describe('a write and its prune in one batch', () => {
    it('writes the row and prunes in one batch, with no second write', async () => {
      const now = Date.now();
      await insertRow(DOMAIN, 'expired', 1, now - REACH_MS - 10);
      const { db, counts } = batchingDb(false);
      await noteRecentQr(db, DOMAIN, 'new', now, now);
      expect(counts).toEqual({ batch: 1, run: 0 });
      expect(await incarnations('new')).toEqual([[now, 0]]);
      expect(await stored('expired')).toEqual([]);
    });

    it('a prune that fails in D1 rolls the batch back, and the row is written on its own', async () => {
      const now = Date.now();
      await insertRow(DOMAIN, 'expired', 1, now - REACH_MS - 10);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, counts } = batchingDb(true);
      await noteRecentQr(db, DOMAIN, 'new', now, now);
      await forgetRecentQr(db, DOMAIN, 'gone', now, now);
      expect(counts).toEqual({ batch: 2, run: 2 });
      expect(await incarnations('new')).toEqual([[now, 0]]);
      expect(await incarnations('gone')).toEqual([[now, 1]]);
      expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['new']);
      // Left for the next write's prune
      expect(await stored('expired')).toHaveLength(1);
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
        expect.stringContaining('writing the create alone'),
        expect.stringContaining('writing the delete alone'),
      ]);
    });

    it('a batch answering without the row written writes it on its own; a failed prune alone is logged', async () => {
      const now = Date.now();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await noteRecentQr(answering([{ success: false }, { success: true }]), DOMAIN, 'a', now, now);
      expect(await incarnations('a')).toEqual([[now, 0]]);
      await noteRecentQr(answering([{ success: true }, { success: false }]), DOMAIN, 'b', now, now);
      // The batch said the row was written (it was not, here): no second write
      expect(await stored('b')).toEqual([]);
      expect(warn.mock.calls).toEqual([['[QR] Expired recent rows were not pruned']]);
    });
  });

  it('same-millisecond times: distinct codes all listed; a delete hides only its own incarnation', async () => {
    const now = Date.now();
    await noteRecentQr(env.DB, DOMAIN, 'b', now, now);
    await noteRecentQr(env.DB, DOMAIN, 'a', now, now);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['a', 'b']);
    await forgetRecentQr(env.DB, DOMAIN, 'a', now, now);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual(['b']);
    // Another incarnation of 'a' is its own row, listed
    await noteRecentQr(env.DB, DOMAIN, 'a', now + 1, now + 1);
    expect(await recentQrIds(env.DB, DOMAIN, now + 1)).toEqual(['b', 'a']);
  });

  it('a fractional createdAt is rounded up, and a non-finite one writes nothing', async () => {
    const now = Date.now();
    await noteRecentQr(env.DB, DOMAIN, 'frac', now - 0.5, now);
    expect(await incarnations('frac')).toEqual([[now, 0]]);
    await forgetRecentQr(env.DB, DOMAIN, 'frac', now - 0.5, now);
    expect(await recentQrIds(env.DB, DOMAIN, now)).toEqual([]);
    // The listing compares a fractional record the same way
    await noteRecentQr(env.DB, DOMAIN, 'merged', now - 0.5, now);
    await putQR(env.ROUTES, makeQR('merged', now, now - 0.5));
    const kv = laggingKv(new Set([qrKey(DOMAIN, 'merged')]));
    expect((await listQRs(kv, DOMAIN, { offset: 0 }, env.DB)).items.map(item => item.id)).toEqual([
      'merged',
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noteRecentQr(env.DB, DOMAIN, 'nan', Number.NaN, now);
    await forgetRecentQr(env.DB, DOMAIN, 'nan', Number.POSITIVE_INFINITY, now);
    expect(await stored('nan')).toEqual([]);
    expect(warn.mock.calls).toEqual([
      ['[QR] Recent create not recorded: no valid createdAt'],
      ['[QR] Recent delete not recorded: no valid createdAt'],
    ]);
  });

  it('forgetRecentQr leaves another id, another domain and another incarnation alone', async () => {
    const now = Date.now();
    await noteRecentQr(env.DB, DOMAIN, 'a', now, now);
    await forgetRecentQr(env.DB, DOMAIN, 'missing', now, now);
    await forgetRecentQr(env.DB, OTHER, 'a', now, now);
    await forgetRecentQr(env.DB, DOMAIN, 'a', now - 1, now);
    expect(await recentQrs(env.DB, DOMAIN, now)).toEqual([{ id: 'a', createdAt: now }]);
  });
});
