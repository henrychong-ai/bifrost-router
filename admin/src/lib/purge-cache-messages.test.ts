import { describe, expect, it } from 'vitest';
import { purgeCacheMessages, ROUTE_DISCOVERY_INCOMPLETE_MESSAGE } from './purge-cache-messages';

const base = { purged: 2, failed: 0, urls: ['a', 'b'], routeDiscoveryComplete: true };

describe('purgeCacheMessages', () => {
  it('reports the counts of a complete purge', () => {
    expect(purgeCacheMessages(base)).toEqual([{ kind: 'success', text: 'Purged 2 cache entries' }]);
    expect(purgeCacheMessages({ ...base, purged: 1, failed: 1 })).toEqual([
      { kind: 'warning', text: 'Purged 1, failed 1 cache entry' },
    ]);
    expect(purgeCacheMessages({ ...base, purged: 0, urls: [] })).toEqual([
      { kind: 'info', text: 'No cache entries to purge' },
    ]);
    expect(purgeCacheMessages({ ...base, purged: 0 })[0]?.text).toContain('purge not configured');
  });

  it('never lets a purge without route discovery read as a full one (v1.38.0)', () => {
    expect(
      purgeCacheMessages({
        purged: 1,
        failed: 0,
        urls: ['https://files.example.com/a.pdf'],
        routeDiscoveryComplete: false,
      }),
    ).toEqual([
      { kind: 'success', text: 'Purged 1 cache entry' },
      { kind: 'warning', text: ROUTE_DISCOVERY_INCOMPLETE_MESSAGE },
    ]);
  });
});
