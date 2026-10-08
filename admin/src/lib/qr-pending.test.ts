import { type QRCode, QRDesignSchema, qrMatchesListFilters } from '@bifrost/shared';
import { describe, expect, it, vi } from 'vitest';
import type { QRListMeta, QrQueryParams } from './api-client';
import {
  createPendingQrStore,
  PENDING_QR_CREATED_TTL_MS,
  PENDING_QR_TTL_MS,
  type QrListPage,
} from './qr-pending';

function qr(id: string, overrides: Partial<QRCode> = {}): QRCode {
  return {
    id,
    domain: 'example.com',
    type: 'url',
    payload: { url: `https://example.com/${id}` },
    design: QRDesignSchema.parse({}),
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test',
    ...overrides,
  };
}

function page(items: QRCode[], meta: Partial<QRListMeta> = {}): QrListPage {
  return {
    items,
    meta: {
      total: items.length,
      count: items.length,
      offset: 0,
      limit: 50,
      hasMore: false,
      ...meta,
    },
  };
}

const firstPage: QrQueryParams = { domain: 'example.com', limit: 50, offset: 0 };
const ids = (result: QrListPage) => result.items.map(item => item.id);
const descriptions = (result: QrListPage) => result.items.map(item => item.description);

/**
 * The store as the list query uses it: the fetch feeds the raw page
 * to `ingest`, and every read projects it. `merge` is that pair, for tests
 * that model a fetch followed by a read.
 */
type TestStore = ReturnType<typeof createPendingQrStore> & {
  merge(params: QrQueryParams | undefined, page: QrListPage): QrListPage;
};

function clockedStore() {
  let time = 1_000;
  const base = createPendingQrStore(() => time);
  const store: TestStore = Object.assign(base, {
    merge(params: QrQueryParams | undefined, raw: QrListPage) {
      base.ingest(raw);
      return base.project(params, raw);
    },
  });
  return { store, advance: (ms: number) => (time += ms), now: () => time };
}

/** Two incarnations of one code: A, deleted, and B, re-created with its id. */
const A = (overrides: Partial<QRCode> = {}) =>
  qr('a', { createdAt: 5_000, updatedAt: 5_000, description: 'A', ...overrides });
const B = (overrides: Partial<QRCode> = {}) =>
  qr('a', { createdAt: 10_100, updatedAt: 10_100, description: 'B', ...overrides });

describe('pending QR store', () => {
  it('keeps both codes of successive creates through stale refetches', () => {
    const { store } = clockedStore();
    const older = qr('older', { updatedAt: 5 });
    store.remember(qr('a', { updatedAt: 10 }));
    expect(ids(store.merge(firstPage, page([older])))).toEqual(['a', 'older']);

    store.remember(qr('b', { updatedAt: 20 }));
    // The refetch after B still lists neither A nor B
    const merged = store.merge(firstPage, page([older]));
    expect(ids(merged)).toEqual(['b', 'a', 'older']);
    expect(merged.meta).toEqual({ total: 1, count: 3, offset: 0, limit: 50, hasMore: false });
  });

  it('keeps a created code after the server lists it, so a later stale page still shows it', () => {
    const { store } = clockedStore();
    const a = qr('a', { updatedAt: 10 });
    store.remember(a);
    const current = page([a]);
    // A current listing is returned untouched, and does not end the entry
    expect(store.merge(firstPage, current)).toBe(current);
    expect(store.size()).toBe(1);
    expect(ids(store.merge(firstPage, page([])))).toEqual(['a']);
  });

  it('keeps a created code the server lists on a later page, without adding it to page 1 there', () => {
    const { store } = clockedStore();
    const old = qr('old', { updatedAt: 1 });
    store.remember(old);
    store.merge({ ...firstPage, offset: 50 }, page([old], { offset: 50 }));
    expect(store.size()).toBe(1);
    const newer = [qr('x', { updatedAt: 9 }), qr('y', { updatedAt: 8 })];
    expect(ids(store.merge(firstPage, page(newer, { hasMore: true })))).toEqual(['x', 'y']);
  });

  it('never brings back a deleted code, whatever the filters or the listing', () => {
    const { store } = clockedStore();
    const a = qr('a', { tags: ['print'] });
    store.remember(a);
    store.markDeleted('example.com', 'a', 1);
    for (const params of [
      firstPage,
      { ...firstPage, type: 'url' },
      { ...firstPage, tag: 'print' },
      { ...firstPage, offset: 50 },
    ]) {
      expect(ids(store.merge(params, page([])))).toEqual([]);
      // A stale listing that still holds the deleted row drops it too
      const stale = store.merge(params, page([a, qr('b')], { offset: params.offset ?? 0 }));
      expect(ids(stale)).toEqual(['b']);
      expect(stale.meta.count).toBe(1);
    }
  });

  it('a deletion of a known incarnation hides it past the entry TTL, whatever the clocks', () => {
    const { store, advance, now } = clockedStore();
    // The server's clock is ahead of the dashboard's: the edit is stamped later than now
    const edited = qr('a', { updatedAt: now() + 10 * 60_000 });
    store.observeOwn(edited);
    advance(PENDING_QR_TTL_MS + 1);
    store.markDeleted('example.com', 'a', edited.createdAt);
    // A stale listing that still holds the edit must not bring it back, nor
    // any later row of the same incarnation
    expect(ids(store.merge(firstPage, page([edited])))).toEqual([]);
    expect(
      ids(store.merge(firstPage, page([{ ...edited, updatedAt: edited.updatedAt + 1 }]))),
    ).toEqual([]);
    // Another incarnation (a later createdAt) is a re-creation
    const recreated = qr('a', { createdAt: 2, updatedAt: 2 });
    expect(ids(store.merge(firstPage, page([recreated])))).toEqual(['a']);
  });

  it('keeps a tombstone until its TTL, then lets listings through again', () => {
    const { store, advance } = clockedStore();
    const a = qr('a');
    store.markDeleted('example.com', 'a', 1);
    advance(PENDING_QR_TTL_MS);
    expect(ids(store.merge(firstPage, page([a])))).toEqual([]);
    advance(1);
    expect(ids(store.merge(firstPage, page([a])))).toEqual(['a']);
  });

  it("never hides another incarnation, this session's own included, whatever the clocks", () => {
    const { store } = clockedStore();
    // Incarnation 1 deleted at 10,000 on the server's clock
    store.markDeleted('example.com', 'a', 1);
    // A later incarnation stamped BEFORE the deletion (a slower clock): shown
    store.observeOwn(qr('a', { description: 'updated', createdAt: 5, updatedAt: 6 }));
    expect(
      descriptions(store.merge(firstPage, page([qr('a', { createdAt: 5, updatedAt: 5 })]))),
    ).toEqual(['updated']);
    // Only a create adds a code to page 1
    expect(ids(store.merge(firstPage, page([])))).toEqual([]);
    store.markDeleted('example.com', 'b', 1);
    store.remember(qr('b', { createdAt: 6, updatedAt: 6 }));
    expect(ids(store.merge(firstPage, page([])))).toEqual(['b']);
  });

  it('re-created in the same second as its deletion, in this session: shown at once', () => {
    const { store } = clockedStore();
    store.markDeleted('example.com', 'a', 1);
    store.remember(qr('a', { description: 'again', createdAt: 10_050, updatedAt: 10_050 }));
    expect(descriptions(store.merge(firstPage, page([])))).toEqual(['again']);
    // A stale listing of the deleted incarnation shows the re-created one
    expect(descriptions(store.merge(firstPage, page([qr('a', { updatedAt: 9_000 })])))).toEqual([
      'again',
    ]);
  });

  it('expires an entry the server never lists after the TTL', () => {
    const { store, advance } = clockedStore();
    store.remember(qr('a', { updatedAt: 10 }));
    advance(PENDING_QR_TTL_MS);
    // The version is still held for a stale row of it
    const stale = page([qr('a', { updatedAt: 5 })]);
    expect(store.project(firstPage, stale).items[0]?.updatedAt).toBe(10);
    advance(1);
    expect(store.project(firstPage, stale)).toBe(stale);
    store.ingest(page([]));
    expect(store.size()).toBe(0);
  });

  // v1.40.0: the page-1 addition of a created code lasts 90 s; versions and
  // deletion tombstones keep the 5-minute TTL
  it('adds a created code to page 1 for PENDING_QR_CREATED_TTL_MS only', () => {
    const { store, advance } = clockedStore();
    expect(PENDING_QR_CREATED_TTL_MS).toBe(90 * 1000);
    store.remember(qr('a'));
    advance(PENDING_QR_CREATED_TTL_MS);
    expect(ids(store.merge(firstPage, page([])))).toEqual(['a']);
    advance(1);
    expect(ids(store.merge(firstPage, page([])))).toEqual([]);
    // Still held as a version, well inside the longer TTL
    expect(store.size()).toBe(1);
  });

  // v1.40.0 review: nothing else changes when the mark expires, and the list
  // query memoises its projection on the snapshot, so the store announces it
  it('announces the created-mark expiry, so an identical refetch no longer shows the row', () => {
    let time = 1_000;
    const timers: Array<{ run: () => void; at: number }> = [];
    const store = createPendingQrStore(
      () => time,
      (run, ms) => timers.push({ run, at: time + ms }),
    );
    const listener = vi.fn<() => void>();
    store.subscribe(listener);
    store.remember(qr('a'));
    const page1 = page([]);
    expect(ids(store.project(firstPage, page1))).toEqual(['a']);
    const before = store.getSnapshot();
    listener.mockClear();

    time += PENDING_QR_CREATED_TTL_MS + 1;
    for (const timer of timers.filter(entry => entry.at <= time)) timer.run();
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(before);
    expect(ids(store.getSnapshot().project(firstPage, page1))).toEqual([]);
  });

  it('keeps a deletion tombstone for the full TTL, past the created-mark lifetime', () => {
    const { store, advance } = clockedStore();
    const gone = qr('gone', { createdAt: 3, updatedAt: 3 });
    store.markDeleted('example.com', 'gone', 3);
    advance(PENDING_QR_CREATED_TTL_MS + 1);
    expect(ids(store.merge(firstPage, page([gone])))).toEqual([]);
    advance(PENDING_QR_TTL_MS - PENDING_QR_CREATED_TTL_MS - 1);
    expect(ids(store.merge(firstPage, page([gone])))).toEqual([]);
    advance(1);
    expect(ids(store.merge(firstPage, page([gone])))).toEqual(['gone']);
  });

  it('restarts the TTL when it learns a newer version, not when it sees the same one', () => {
    const { store, advance } = clockedStore();
    store.remember(qr('a', { updatedAt: 10 }));
    advance(60_000);
    // The same version listed: no restart
    store.merge(firstPage, page([qr('a', { updatedAt: 10 })]));
    advance(PENDING_QR_TTL_MS - 60_000 + 1);
    expect(store.size()).toBe(1);
    expect(ids(store.merge(firstPage, page([])))).toEqual([]);
    expect(store.size()).toBe(0);

    // A newer version (here an edit) restarts it
    store.remember(qr('b', { updatedAt: 10 }));
    advance(60_000);
    store.observeOwn(qr('b', { updatedAt: 20 }));
    advance(60_000);
    expect(ids(store.merge(firstPage, page([qr('b', { updatedAt: 10 })])))).toEqual(['b']);
    expect(store.merge(firstPage, page([qr('b', { updatedAt: 10 })])).items[0]?.updatedAt).toBe(20);
  });

  it('merges only into its own domain, the first page, and lists whose filters match', () => {
    const { store } = clockedStore();
    const created = qr('new-code', { description: 'Summer Sale brochure', tags: ['print'] });
    store.remember(created);
    const lists: Array<QrQueryParams | undefined> = [
      { domain: 'secondary.example.net' },
      { ...firstPage, offset: 50 },
      { ...firstPage, type: 'text' },
      { ...firstPage, tag: 'web' },
      { ...firstPage, search: 'nothing-like-it' },
      undefined,
      { limit: 50 },
    ];
    for (const params of lists) {
      const unchanged = page([], { offset: params?.offset ?? 0 });
      expect(store.merge(params, unchanged)).toBe(unchanged);
    }
    for (const params of [
      { ...firstPage, search: 'SUMMER sale' },
      { ...firstPage, search: 'new-c' },
      { ...firstPage, tag: 'print', type: 'url' },
    ]) {
      expect(store.merge(params, page([])).items).toEqual([created]);
    }
  });

  it('shows every server row and the pending code exactly once across two pages', () => {
    const { store } = clockedStore();
    const a = qr('a', { updatedAt: 5 });
    const b = qr('b', { updatedAt: 4 });
    const c = qr('c', { updatedAt: 3 });
    const pendingCode = qr('new', { updatedAt: 10 });
    store.remember(pendingCode);
    // The server's two pages of [a, b, c] at limit 2
    const page1 = store.merge(
      { domain: 'example.com', limit: 2, offset: 0 },
      page([a, b], { total: 3, limit: 2, hasMore: true }),
    );
    const page2 = store.merge(
      { domain: 'example.com', limit: 2, offset: 2 },
      page([c], { total: 3, limit: 2, offset: 2, hasMore: false }),
    );

    expect(ids(page1)).toEqual(['new', 'a', 'b']);
    expect(page1.meta).toEqual({ total: 3, count: 3, offset: 0, limit: 2, hasMore: true });
    expect(ids(page2)).toEqual(['c']);
    const shown = [...ids(page1), ...ids(page2)];
    expect(shown.toSorted()).toEqual(['a', 'b', 'c', 'new']);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('keeps the server total, limit and hasMore on an unpaginated list', () => {
    const { store } = clockedStore();
    store.remember(qr('new'));
    const merged = store.merge(
      { domain: 'example.com' },
      page([qr('a')], { total: 1, limit: 1, hasMore: false }),
    );
    expect(merged.meta).toEqual({ total: 1, count: 2, offset: 0, limit: 1, hasMore: false });
  });

  it('keeps a full single page at its server total: no second page appears', () => {
    const { store } = clockedStore();
    store.remember(qr('new', { updatedAt: 100 }));
    const rows = Array.from({ length: 50 }, (_, i) => qr(`r${i}`, { updatedAt: 50 - i }));
    const merged = store.merge(firstPage, page(rows, { total: 50, limit: 50, hasMore: false }));

    expect(merged.items).toHaveLength(51);
    expect(merged.items[0]?.id).toBe('new');
    expect(merged.meta).toEqual({ total: 50, count: 51, offset: 0, limit: 50, hasMore: false });
  });

  it('shows an update to a still-pending code, and never adds a code it only saw edited', () => {
    const { store } = clockedStore();
    store.remember(qr('a', { description: 'first' }));
    store.observeOwn(qr('a', { description: 'second', updatedAt: 2 }));
    store.observeOwn(qr('other', { updatedAt: 2 }));
    expect(store.merge(firstPage, page([])).items.map(item => item.description)).toEqual([
      'second',
    ]);
    expect(store.size()).toBe(2);
  });

  it('keeps an edit over a stale listing of the older version, and after the server catches up', () => {
    const { store } = clockedStore();
    // Created earlier (already listed), then edited in this session
    store.observeOwn(qr('a', { description: 'new', updatedAt: 20 }));
    const stale = store.merge(firstPage, page([qr('a', { description: 'old', updatedAt: 10 })]));
    expect(stale.items.map(item => item.description)).toEqual(['new']);
    expect(stale.meta.count).toBe(1);
    const current = qr('a', { description: 'new', updatedAt: 20 });
    expect(store.merge(firstPage, page([current])).items).toEqual([current]);
    // Seeing the current row does not end the entry: a later stale response
    // still shows the edit
    expect(store.size()).toBe(1);
    const late = store.merge(firstPage, page([qr('a', { description: 'old', updatedAt: 10 })]));
    expect(late.items.map(item => item.description)).toEqual(['new']);
  });

  it('keeps the edit on a later page too, and applies the filters to the edited record', () => {
    const { store } = clockedStore();
    store.remember(qr('a', { tags: ['print'], updatedAt: 10 }));
    store.observeOwn(qr('a', { tags: ['web'], updatedAt: 20 }));
    // The stale row still has the old tag: the list filtered on it drops the row
    const filtered = store.merge(
      { ...firstPage, tag: 'print' },
      page([qr('a', { tags: ['print'], updatedAt: 10 }), qr('b', { tags: ['print'] })]),
    );
    expect(ids(filtered)).toEqual(['b']);
    // An unfiltered later page shows the edit in place
    const later = store.merge(
      { ...firstPage, offset: 50 },
      page([qr('a', { tags: ['print'], updatedAt: 10 })], { offset: 50 }),
    );
    expect(later.items[0]?.tags).toEqual(['web']);
    expect(store.size()).toBe(2);
  });

  it.each([
    ['still matches the filter', ['print', 'web'], ['a', 'b']],
    ['no longer matches the filter', ['web'], ['b']],
  ])(
    'shows v20 over a stale filtered v10 that arrives after it, when v20 %s',
    (_label, freshTags, expected) => {
      const { store } = clockedStore();
      const v20 = qr('a', { description: 'v20', tags: freshTags, updatedAt: 20 });
      // The fresh unfiltered response arrives first, from the server
      expect(store.merge(firstPage, page([v20])).items).toEqual([v20]);
      // Then a response for the tag filter, fetched before the edit
      const stale = store.merge(
        { ...firstPage, tag: 'print' },
        page([
          qr('a', { description: 'v10', tags: ['print'], updatedAt: 10 }),
          qr('b', { tags: ['print'], updatedAt: 5 }),
        ]),
      );
      expect(ids(stale)).toEqual(expected);
      expect(stale.items.map(item => item.description)).not.toContain('v10');
    },
  );

  it('compares each response independently: never moves backwards, and raises to a newer row', () => {
    const { store } = clockedStore();
    store.observeOwn(qr('a', { description: 'v20', updatedAt: 20 }));
    // An older update response arriving late is ignored
    store.observeOwn(qr('a', { description: 'v15', updatedAt: 15 }));
    expect(descriptions(store.merge(firstPage, page([qr('a', { updatedAt: 1 })])))).toEqual([
      'v20',
    ]);
    // A server row newer than the known record is shown and becomes the known record
    const v30 = qr('a', { description: 'v30', updatedAt: 30 });
    expect(store.merge(firstPage, page([v30])).items).toEqual([v30]);
    expect(descriptions(store.merge(firstPage, page([qr('a', { updatedAt: 20 })])))).toEqual([
      'v30',
    ]);
  });

  it('keeps a newer version it has already seen when a create response arrives late', () => {
    const { store } = clockedStore();
    // A listing showed someone's later edit before this session's create returned
    store.merge(firstPage, page([qr('a', { description: 'edited', updatedAt: 9 })]));
    store.remember(qr('a', { description: 'created', updatedAt: 3 }));
    // Still the newer version, and now added to page 1 as a created code
    expect(store.merge(firstPage, page([])).items.map(item => item.description)).toEqual([
      'edited',
    ]);
  });

  it('forgets everything on clear', () => {
    const { store } = clockedStore();
    store.remember(qr('a'));
    store.markDeleted('example.com', 'b', 1);
    store.merge(firstPage, page([qr('c')]));
    expect(store.size()).toBe(3);
    store.clear();
    expect(store.size()).toBe(0);
    expect(ids(store.merge(firstPage, page([qr('b')])))).toEqual(['b']);
  });

  it('expires after 5 minutes, well past KV list lag (about 60 seconds, sometimes more)', () => {
    expect(PENDING_QR_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('does not add a code that sorts after page 1 while more pages follow: no duplicate', () => {
    const { store } = clockedStore();
    const a = qr('a', { updatedAt: 5 });
    const b = qr('b', { updatedAt: 4 });
    const old = qr('old', { updatedAt: 1 });
    store.remember(old);
    const page1 = store.merge(
      { domain: 'example.com', limit: 2, offset: 0 },
      page([a, b], { total: 3, limit: 2, hasMore: true }),
    );
    expect(ids(page1)).toEqual(['a', 'b']);
    // The server lists it on page 2: shown once there
    const page2 = store.merge(
      { domain: 'example.com', limit: 2, offset: 2 },
      page([old], { total: 3, limit: 2, offset: 2, hasMore: false }),
    );
    expect(ids(page2)).toEqual(['old']);
    // With no further page, page 1 is where it belongs
    expect(ids(store.merge(firstPage, page([a, b], { hasMore: false })))).toEqual([
      'a',
      'b',
      'old',
    ]);
  });

  it.each([
    ['summer sale', true],
    ['Sale_Summer', true],
    ['summersale', true],
    ['brochure summer', true],
    ['new co', true],
    ['autumn', false],
  ])(
    'adds a created code for search %j exactly when the Worker would list it',
    (search, listed) => {
      const { store } = clockedStore();
      const created = qr('new-code', { description: 'Summer Sale brochure' });
      store.remember(created);
      expect(qrMatchesListFilters(created, { search })).toBe(listed);
      expect(ids(store.merge({ ...firstPage, search }, page([])))).toEqual(
        listed ? ['new-code'] : [],
      );
    },
  );

  describe('read-time projection', () => {
    it('applies a newer version to a page cached before it was known, without a refetch', () => {
      const { store } = clockedStore();
      // A filtered page fetched (and cached raw) while `a` was at v10
      const cached = page([
        qr('a', { tags: ['print'], updatedAt: 10 }),
        qr('b', { tags: ['print'] }),
      ]);
      store.ingest(cached);
      const printOnly = { ...firstPage, tag: 'print' };
      expect(store.project(printOnly, cached)).toBe(cached);

      // v20 arrives from another listing; the cached page is read again
      store.ingest(page([qr('a', { tags: ['print', 'web'], description: 'v20', updatedAt: 20 })]));
      expect(descriptions(store.project(printOnly, cached))).toEqual(['v20', undefined]);
      // v30 no longer matches the cached page's filter: hidden there
      store.observeOwn(qr('a', { tags: ['web'], updatedAt: 30 }));
      expect(ids(store.project(printOnly, cached))).toEqual(['b']);
      // The raw page itself is never changed
      expect(cached.items[0]?.updatedAt).toBe(10);
    });

    it('hides a deleted code in a page cached before the deletion', () => {
      const { store } = clockedStore();
      const cached = page([qr('a'), qr('b')]);
      store.ingest(cached);
      store.markDeleted('example.com', 'a', 1);
      expect(ids(store.project({ ...firstPage, offset: 50 }, cached))).toEqual(['b']);
    });

    it('is pure: a read changes neither the entries nor the snapshot', () => {
      const { store, advance } = clockedStore();
      store.remember(qr('a'));
      store.markDeleted('example.com', 'b', 1);
      const snapshot = store.getSnapshot();
      advance(PENDING_QR_TTL_MS + 1);
      // Expired entries are ignored at read time, but only a write prunes them
      expect(ids(store.project(firstPage, page([qr('b')])))).toEqual(['b']);
      expect(store.size()).toBe(2);
      expect(store.getSnapshot()).toBe(snapshot);
      store.ingest(page([]));
      expect(store.size()).toBe(0);
    });

    it('changes the snapshot and notifies exactly when the store changes', () => {
      const { store } = clockedStore();
      const listener = vi.fn<() => void>();
      const unsubscribe = store.subscribe(listener);
      const first = store.getSnapshot();
      expect(first.version).toBe(0);

      store.ingest(page([qr('a', { updatedAt: 5 })]));
      expect(listener).toHaveBeenCalledTimes(1);
      const second = store.getSnapshot();
      expect(second).not.toBe(first);
      expect(second.version).toBe(1);

      // Nothing new: the same rows again, or an older version
      store.ingest(page([qr('a', { updatedAt: 5 })]));
      store.observeOwn(qr('a', { updatedAt: 4 }));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot()).toBe(second);

      store.observeOwn(qr('a', { updatedAt: 6 }));
      store.remember(qr('b'));
      store.markDeleted('example.com', 'a', 1);
      store.clear();
      expect(listener).toHaveBeenCalledTimes(5);
      expect(store.getSnapshot().version).toBe(5);

      unsubscribe();
      store.remember(qr('c'));
      expect(listener).toHaveBeenCalledTimes(5);
    });

    it('projects through any snapshot with the store as it is now', () => {
      const { store } = clockedStore();
      const view = store.getSnapshot();
      store.markDeleted('example.com', 'a', 1);
      expect(ids(view.project(firstPage, page([qr('a'), qr('b')])))).toEqual(['b']);
    });

    it('shows newer rows as listed on a list without params', () => {
      const { store } = clockedStore();
      store.observeOwn(qr('a', { description: 'v20', updatedAt: 20 }));
      store.remember(qr('created'));
      expect(descriptions(store.project(undefined, page([qr('a', { updatedAt: 10 })])))).toEqual([
        'v20',
      ]);
    });
  });

  describe('incarnations (a deleted code and a code re-created with its id)', () => {
    it('a re-create on a slower clock survives a stale row of the deleted code stamped later', () => {
      const { store } = clockedStore();
      store.ingest(page([A()]));
      // Deleted at 10,123 on the server's clock
      store.markDeleted('example.com', 'a', 5_000);
      // Re-created in this session, stamped 10,100 by a slower clock
      store.remember(B());
      // A stale row of the deleted code, stamped 10,128 (after the deletion)
      expect(descriptions(store.merge(firstPage, page([A({ updatedAt: 10_128 })])))).toEqual(['B']);
      expect(descriptions(store.merge(firstPage, page([])))).toEqual(['B']);
    });

    it('keeps every deleted incarnation hidden: delete A, re-create B, delete B', () => {
      const { store } = clockedStore();
      store.remember(A());
      store.markDeleted('example.com', 'a', 5_000);
      store.remember(B());
      store.markDeleted('example.com', 'a', 10_100);
      // A stale listing of A, then of B: both stay hidden
      expect(ids(store.merge(firstPage, page([A({ updatedAt: 7_000 })])))).toEqual([]);
      expect(ids(store.merge(firstPage, page([B({ updatedAt: 10_900 })])))).toEqual([]);
      // A third incarnation is shown
      const C = qr('a', { createdAt: 12_000, updatedAt: 12_000, description: 'C' });
      expect(descriptions(store.merge(firstPage, page([C])))).toEqual(['C']);
    });

    it('drops a delayed answer to an update issued before the deletion', () => {
      const { store } = clockedStore();
      store.remember(A());
      store.markDeleted('example.com', 'a', 5_000);
      // The update was sent before the delete; its answer arrives after it
      store.observeOwn(A({ updatedAt: 5_500, description: 'late edit' }));
      expect(ids(store.merge(firstPage, page([])))).toEqual([]);
      expect(ids(store.merge(firstPage, page([A({ updatedAt: 5_500 })])))).toEqual([]);
    });

    it('keeps both tombstones when the delete callbacks arrive out of order', () => {
      const { store } = clockedStore();
      store.remember(B());
      // B's deletion lands first, A's (an older incarnation) last
      store.markDeleted('example.com', 'a', 10_100);
      store.markDeleted('example.com', 'a', 5_000);
      expect(ids(store.merge(firstPage, page([B()])))).toEqual([]);
      expect(ids(store.merge(firstPage, page([A()])))).toEqual([]);
      expect(store.size()).toBe(2);
    });

    it('tombstones the incarnation the request deleted, never the one the store knows now', () => {
      const { store } = clockedStore();
      store.ingest(page([A()]));
      // The delete of A is sent; before its reply, B is re-created and listed
      store.remember(B());
      store.ingest(page([B()]));
      // The delayed reply names A, the incarnation the request deleted
      store.markDeleted('example.com', 'a', 5_000);
      expect(descriptions(store.merge(firstPage, page([B()])))).toEqual(['B']);
      expect(descriptions(store.merge(firstPage, page([A()])))).toEqual(['B']);
      // A reply that names no incarnation (an unreadable record was deleted)
      // never takes one from the store, and hides no readable version
      store.markDeleted('example.com', 'a');
      expect(descriptions(store.merge(firstPage, page([B()])))).toEqual(['B']);
    });

    it("shows another session's re-create, whatever its clock says", () => {
      const { store } = clockedStore();
      store.markDeleted('example.com', 'a', 5_000);
      // Re-created elsewhere, stamped before the deletion by its clock
      const other = qr('a', { createdAt: 19_000, updatedAt: 19_000, description: 'elsewhere' });
      expect(descriptions(store.merge(firstPage, page([other])))).toEqual(['elsewhere']);
    });

    it('expires each tombstone on its own TTL', () => {
      const { store, advance } = clockedStore();
      store.markDeleted('example.com', 'a', 5_000);
      advance(PENDING_QR_TTL_MS / 2);
      store.markDeleted('example.com', 'a', 10_100);
      advance(PENDING_QR_TTL_MS / 2 + 1);
      // A's tombstone has expired, B's has not
      expect(ids(store.merge(firstPage, page([A()])))).toEqual(['a']);
      expect(ids(store.merge(firstPage, page([B()])))).toEqual([]);
    });

    it('hides the row of an unreadable record while a deletion of its code is known', () => {
      const { store, advance } = clockedStore();
      const invalid = [{ domain: 'example.com', id: 'a', invalid: true as const }];
      const raw = { ...page([]), invalid };
      expect(store.project(firstPage, raw)).toBe(raw);
      // Deleting it: the answer names no incarnation
      store.markDeleted('example.com', 'a');
      expect(store.project(firstPage, raw).invalid).toEqual([]);
      advance(PENDING_QR_TTL_MS + 1);
      expect(store.project(firstPage, raw).invalid).toEqual(invalid);
    });
  });

  describe('versions across incarnations', () => {
    it('shows a code re-created elsewhere after the deletion, and hides older rows of it', () => {
      const { store } = clockedStore();
      store.markDeleted('example.com', 'a', 1);
      // A stale listing of the deleted code: hidden
      expect(ids(store.merge(firstPage, page([qr('a', { updatedAt: 50 })])))).toEqual([]);
      // Re-created elsewhere: another incarnation, shown in this listing and,
      // in place of a stale row of the deleted one, in every later read
      const recreated = qr('a', { description: 'again', createdAt: 60, updatedAt: 60 });
      expect(store.merge(firstPage, page([recreated])).items).toEqual([recreated]);
      expect(store.project(firstPage, page([qr('a', { updatedAt: 50 })])).items).toEqual([
        recreated,
      ]);
    });

    it('shows a re-created row even in a page read before it was ingested', () => {
      const { store } = clockedStore();
      store.markDeleted('example.com', 'a', 1);
      const recreated = qr('a', { createdAt: 2, updatedAt: 2 });
      expect(store.project(firstPage, page([recreated])).items).toEqual([recreated]);
    });

    it("lets another session's re-create revive the code, without adding it to page 1", () => {
      const { store } = clockedStore();
      store.markDeleted('example.com', 'a', 1);
      store.ingest(page([qr('a', { description: 'old', updatedAt: 9_999 })]));
      expect(ids(store.project(firstPage, page([qr('a', { updatedAt: 9_999 })])))).toEqual([]);
      store.ingest(page([qr('a', { description: 'new', createdAt: 5, updatedAt: 5 })]));
      // Known again, though not added to page 1: only a create adds a code
      expect(descriptions(store.project(firstPage, page([qr('a', { updatedAt: 1 })])))).toEqual([
        'new',
      ]);
      expect(ids(store.project(firstPage, page([])))).toEqual([]);
    });

    it('compares createdAt before updatedAt: a later incarnation wins, whatever its updatedAt', () => {
      const { store } = clockedStore();
      const older = qr('a', { description: 'A', createdAt: 900, updatedAt: 1_000 });
      const later = qr('a', { description: 'B', createdAt: 950, updatedAt: 998 });
      store.ingest(page([older]));
      store.ingest(page([later]));
      expect(descriptions(store.project(firstPage, page([older])))).toEqual(['B']);
      // An older incarnation's later edit never replaces B
      store.observeOwn({ ...older, updatedAt: 2_000 });
      expect(descriptions(store.project(firstPage, page([older])))).toEqual(['B']);
    });
  });
});
