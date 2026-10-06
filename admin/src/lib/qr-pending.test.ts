import { type QRCode, QRDesignSchema, qrMatchesListFilters } from '@bifrost/shared';
import { describe, expect, it, vi } from 'vitest';
import type { QRListMeta, QrQueryParams } from './api-client';
import { createPendingQrStore, PENDING_QR_TTL_MS, type QrListPage } from './qr-pending';
import { TOMBSTONE_SKEW_MARGIN_MS } from './server-time';

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
    store.markDeleted('example.com', 'a');
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

  it('a deletion keeps the known version of an entry past its TTL', () => {
    const { store, advance, now } = clockedStore();
    // The server's clock is ahead of the dashboard's: the edit is stamped later than now
    const edited = qr('a', { updatedAt: now() + 10 * 60_000 });
    store.observeOwn(edited);
    advance(PENDING_QR_TTL_MS + 1);
    store.markDeleted('example.com', 'a');
    // A stale listing that still holds the edit must not bring it back
    expect(ids(store.merge(firstPage, page([edited])))).toEqual([]);
    // A version later than the one the session saw is a re-creation
    const recreated = qr('a', { updatedAt: edited.updatedAt + 1 });
    expect(ids(store.merge(firstPage, page([recreated])))).toEqual(['a']);
  });

  it('stamps a tombstone with the server clock, not the dashboard clock', () => {
    // The dashboard clock is an hour AHEAD of the server's
    const ahead = clockedStore();
    ahead.advance(60 * 60 * 1000);
    ahead.store.markDeleted('example.com', 'a', 5_999);
    // Re-created on the server a second after the deletion: shown
    expect(ids(ahead.store.merge(firstPage, page([qr('a', { updatedAt: 7_000 })])))).toEqual(['a']);
    // The dashboard clock is BEHIND: a stale row up to the deletion stays hidden
    const behind = clockedStore();
    behind.store.markDeleted('example.com', 'b', 50_999);
    expect(ids(behind.store.merge(firstPage, page([qr('b', { updatedAt: 50_000 })])))).toEqual([]);
    // With no server time the dashboard clock stands in, as before
    const local = clockedStore();
    local.store.markDeleted('example.com', 'c');
    expect(ids(local.store.merge(firstPage, page([qr('c', { updatedAt: local.now() })])))).toEqual(
      [],
    );
  });

  it('keeps a tombstone until its TTL, then lets listings through again', () => {
    const { store, advance } = clockedStore();
    const a = qr('a');
    store.markDeleted('example.com', 'a');
    advance(PENDING_QR_TTL_MS);
    expect(ids(store.merge(firstPage, page([a])))).toEqual([]);
    advance(1);
    expect(ids(store.merge(firstPage, page([a])))).toEqual(['a']);
  });

  it("supersedes a tombstone with this session's own create or update, whatever the clocks", () => {
    const { store } = clockedStore();
    store.markDeleted('example.com', 'a', 10_000);
    // The server answered the update, so the code exists again: its row shows
    store.observeOwn(qr('a', { description: 'updated', updatedAt: 5 }));
    expect(descriptions(store.merge(firstPage, page([qr('a', { updatedAt: 4 })])))).toEqual([
      'updated',
    ]);
    // Only a create adds a code to page 1
    expect(ids(store.merge(firstPage, page([])))).toEqual([]);
    store.markDeleted('example.com', 'b', 10_000);
    store.remember(qr('b', { updatedAt: 6 }));
    expect(ids(store.merge(firstPage, page([])))).toEqual(['b']);
  });

  it('re-created in the same second as its deletion, in this session: shown at once', () => {
    const { store } = clockedStore();
    store.markDeleted('example.com', 'a', 10_100);
    store.remember(qr('a', { description: 'again', updatedAt: 10_400 }));
    expect(descriptions(store.merge(firstPage, page([])))).toEqual(['again']);
    // A stale listing of the deleted version shows the re-created one
    expect(descriptions(store.merge(firstPage, page([qr('a', { updatedAt: 9_000 })])))).toEqual([
      'again',
    ]);
  });

  it("hides another session's row stamped just after the deletion, within the skew margin", () => {
    const { store } = clockedStore();
    store.markDeleted('example.com', 'a', 10_000);
    expect(ids(store.merge(firstPage, page([qr('a', { updatedAt: 10_005 })])))).toEqual([]);
    expect(
      ids(
        store.merge(firstPage, page([qr('a', { updatedAt: 10_000 + TOMBSTONE_SKEW_MARGIN_MS })])),
      ),
    ).toEqual([]);
    expect(
      ids(
        store.merge(
          firstPage,
          page([qr('a', { updatedAt: 10_000 + TOMBSTONE_SKEW_MARGIN_MS + 1 })]),
        ),
      ),
    ).toEqual(['a']);
    expect(TOMBSTONE_SKEW_MARGIN_MS).toBeGreaterThanOrEqual(1000);
  });

  it('expires an entry the server never lists after the TTL', () => {
    const { store, advance } = clockedStore();
    store.remember(qr('a'));
    advance(PENDING_QR_TTL_MS);
    expect(ids(store.merge(firstPage, page([])))).toEqual(['a']);
    advance(1);
    expect(ids(store.merge(firstPage, page([])))).toEqual([]);
    expect(store.size()).toBe(0);
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
    expect(store.merge(firstPage, page([])).items[0]?.updatedAt).toBe(20);
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
    store.markDeleted('example.com', 'b');
    store.merge(firstPage, page([qr('c')]));
    expect(store.size()).toBe(3);
    store.clear();
    expect(store.size()).toBe(0);
    expect(ids(store.merge(firstPage, page([qr('b')])))).toEqual(['b']);
  });

  it('expires after 90 seconds, covering KV list lag of about 60', () => {
    expect(PENDING_QR_TTL_MS).toBe(90_000);
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
      store.markDeleted('example.com', 'a');
      expect(ids(store.project({ ...firstPage, offset: 50 }, cached))).toEqual(['b']);
    });

    it('is pure: a read changes neither the entries nor the snapshot', () => {
      const { store, advance } = clockedStore();
      store.remember(qr('a'));
      store.markDeleted('example.com', 'b');
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
      store.markDeleted('example.com', 'a');
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
      store.markDeleted('example.com', 'a');
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

  describe('versioned tombstones', () => {
    it('shows a code re-created elsewhere after the deletion, and hides older rows of it', () => {
      const { store, now } = clockedStore();
      store.markDeleted('example.com', 'a');
      const deletedAt = now();
      // A stale listing of the deleted code: hidden
      expect(ids(store.merge(firstPage, page([qr('a', { updatedAt: deletedAt })])))).toEqual([]);
      // Re-created elsewhere: a later version beats the tombstone, in this
      // listing and in every later read
      const recreated = qr('a', {
        description: 'again',
        updatedAt: deletedAt + TOMBSTONE_SKEW_MARGIN_MS + 1,
      });
      expect(store.merge(firstPage, page([recreated])).items).toEqual([recreated]);
      expect(store.project(firstPage, page([qr('a', { updatedAt: deletedAt })])).items).toEqual([
        recreated,
      ]);
    });

    it('shows a re-created row even in a page read before it was ingested', () => {
      const { store, now } = clockedStore();
      store.markDeleted('example.com', 'a');
      const recreated = qr('a', { updatedAt: now() + TOMBSTONE_SKEW_MARGIN_MS + 5 });
      expect(store.project(firstPage, page([recreated])).items).toEqual([recreated]);
    });

    it("lets another session's row later than the deletion and its margin revive the code", () => {
      const { store, now } = clockedStore();
      store.markDeleted('example.com', 'a');
      store.ingest(page([qr('a', { description: 'old', updatedAt: now() })]));
      expect(ids(store.project(firstPage, page([qr('a', { updatedAt: now() })])))).toEqual([]);
      store.ingest(
        page([qr('a', { description: 'new', updatedAt: now() + TOMBSTONE_SKEW_MARGIN_MS + 1 })]),
      );
      // Known again, though not added to page 1: only a create adds a code
      expect(descriptions(store.project(firstPage, page([qr('a', { updatedAt: 1 })])))).toEqual([
        'new',
      ]);
      expect(ids(store.project(firstPage, page([])))).toEqual([]);
    });

    it('stamps the deletion no earlier than the last known version (a clock behind the server)', () => {
      const { store, now } = clockedStore();
      // This session edited `a`; the server's clock is ahead of the dashboard's
      const edited = now() + 60_000;
      store.observeOwn(qr('a', { updatedAt: edited }));
      store.markDeleted('example.com', 'a');
      // A stale listing of the edit must not beat the deletion
      expect(ids(store.merge(firstPage, page([qr('a', { updatedAt: edited })])))).toEqual([]);
      // A second deletion keeps the later stamp
      store.markDeleted('example.com', 'a');
      expect(ids(store.merge(firstPage, page([qr('a', { updatedAt: edited })])))).toEqual([]);
      expect(ids(store.merge(firstPage, page([qr('a', { updatedAt: edited + 1 })])))).toEqual([
        'a',
      ]);
    });
  });
});
