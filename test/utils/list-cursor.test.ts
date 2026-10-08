import { describe, expect, it } from 'vitest';
import { listQRs } from '../../src/kv/qr';
import { listAllDomainRoutes, listDomainRoutes } from '../../src/kv/routes';
import { KVReadError } from '../../src/utils/kv-errors';
import { kvListingPage, ListingCursorError, nextCursor } from '../../src/utils/list-cursor';

/**
 * v1.40.0: one cursor check for every paged KV and R2 listing. The route and
 * QR listings used to take `cursor` as given, so a truncated page without one
 * ended the listing early and a repeated one never ended it.
 */
describe('nextCursor', () => {
  it('ends a complete listing and hands over each new cursor once', () => {
    const seen = new Set<string>();
    expect(nextCursor({ truncated: false, cursor: 'ignored' }, seen)).toBeUndefined();
    expect(nextCursor({ truncated: true, cursor: 'a' }, seen)).toBe('a');
    expect(nextCursor({ truncated: true, cursor: 'b' }, seen)).toBe('b');
    expect([...seen]).toEqual(['a', 'b']);
  });

  it('refuses a truncated page with no cursor, an empty one or a repeated one', () => {
    const seen = new Set(['a']);
    for (const cursor of [undefined, '', 'a']) {
      expect(() => nextCursor({ truncated: true, cursor }, seen)).toThrow(ListingCursorError);
    }
  });

  it('throws the caller’s own error when given one', () => {
    class Own extends Error {}
    expect(() => nextCursor({ truncated: true }, new Set(), () => new Own())).toThrow(Own);
  });

  it('reads a KV list result', () => {
    expect(kvListingPage({ keys: [], list_complete: true, cacheStatus: null })).toEqual({
      truncated: false,
    });
    expect(
      kvListingPage({ keys: [], list_complete: false, cursor: 'c', cacheStatus: null }),
    ).toEqual({ truncated: true, cursor: 'c' });
  });
});

/** A KV namespace whose every listing page is truncated with the same cursor. */
function loopingKv() {
  let lists = 0;
  return {
    kv: {
      list: async () => {
        lists += 1;
        if (lists > 5) throw new Error('listing never stopped');
        return { keys: [], list_complete: false, cursor: 'same', cacheStatus: null };
      },
      get: async () => null,
    } as unknown as KVNamespace,
    lists: () => lists,
  };
}

describe('the route and QR listings', () => {
  it.each([
    ['listDomainRoutes', (kv: KVNamespace) => listDomainRoutes(kv, 'links.example.com')],
    ['listAllDomainRoutes', (kv: KVNamespace) => listAllDomainRoutes(kv)],
    ['listQRs', (kv: KVNamespace) => listQRs(kv, 'links.example.com')],
  ])('%s fails on a repeated cursor instead of looping', async (_name, list) => {
    const { kv, lists } = loopingKv();
    const failure = await list(kv).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(KVReadError);
    expect((failure as KVReadError).cause).toBeInstanceOf(ListingCursorError);
    expect(lists()).toBe(2);
  });
});
