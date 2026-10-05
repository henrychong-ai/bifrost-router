import { type QRCode, QRDesignSchema } from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import type { QRListMeta, QrQueryParams } from './api-client';
import { createPendingQrStore, PENDING_QR_TTL_MS, type QrListPage } from './qr-pending';

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

function clockedStore() {
  let time = 1_000;
  const store = createPendingQrStore(() => time);
  return { store, advance: (ms: number) => (time += ms) };
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
    // total stays the server's (1); only count follows the merged items
    expect(merged.meta).toEqual({ total: 1, count: 3, offset: 0, limit: 50, hasMore: false });
  });

  it('drops a code once the server lists it, and does not add it back to a later stale page', () => {
    const { store } = clockedStore();
    const a = qr('a', { updatedAt: 10 });
    store.remember(a);
    expect(store.merge(firstPage, page([a])).items).toEqual([a]);
    expect(store.size()).toBe(0);
    expect(ids(store.merge(firstPage, page([])))).toEqual([]);
  });

  it('drops a code the server lists on a later page too', () => {
    const { store } = clockedStore();
    store.remember(qr('a'));
    store.merge({ ...firstPage, offset: 50 }, page([qr('a')], { offset: 50 }));
    expect(store.size()).toBe(0);
  });

  it('never brings back a deleted code, whatever the filters', () => {
    const { store } = clockedStore();
    store.remember(qr('a', { tags: ['print'] }));
    store.forget('example.com', 'a');
    for (const params of [
      firstPage,
      { ...firstPage, type: 'url' },
      { ...firstPage, tag: 'print' },
    ]) {
      expect(ids(store.merge(params, page([])))).toEqual([]);
    }
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

  it('merges only into its own domain, the first page, and lists whose filters match', () => {
    const { store } = clockedStore();
    const created = qr('new-code', { description: 'Spring launch brochure', tags: ['print'] });
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
      { ...firstPage, search: 'SPRING launch' },
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

  it('keeps the server limit and hasMore on an unpaginated list', () => {
    const { store } = clockedStore();
    store.remember(qr('new'));
    const merged = store.merge(
      { domain: 'example.com' },
      page([qr('a')], { total: 1, limit: 1, hasMore: false }),
    );
    expect(merged.meta).toEqual({ total: 1, count: 2, offset: 0, limit: 1, hasMore: false });
  });

  it('keeps a full single page a single page: total stays 50 and hasMore false', () => {
    const { store } = clockedStore();
    store.remember(qr('new', { updatedAt: 1_000 }));
    const rows = Array.from({ length: 50 }, (_, i) => qr(`row-${i}`, { updatedAt: 50 - i }));
    const merged = store.merge(firstPage, page(rows, { total: 50, limit: 50, hasMore: false }));
    expect(merged.items).toHaveLength(51);
    expect(merged.items[0]?.id).toBe('new');
    expect(merged.meta).toEqual({ total: 50, count: 51, offset: 0, limit: 50, hasMore: false });
  });

  it('shows an update to a still-pending code, and ignores updates to codes it does not hold', () => {
    const { store } = clockedStore();
    store.remember(qr('a', { description: 'first' }));
    store.update(qr('a', { description: 'second' }));
    store.update(qr('other'));
    expect(store.merge(firstPage, page([])).items.map(item => item.description)).toEqual([
      'second',
    ]);
    expect(store.size()).toBe(1);
  });
});
