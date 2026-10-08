/**
 * What each successful route write leaves in the cached route listings
 * (v1.41.0): the server's answer is written into every listing row of that
 * domain AND path that is still exactly the version the write superseded, so
 * every reader of the row (the editor, the toggle, the badge, the status
 * filter) sees the saved route before the refetch lands. No clock orders two
 * writes (Workers isolates' clocks disagree): a row that is any other version
 * is left for the refetch, whichever stamp is greater, and a delete or a
 * transfer removes only the exact version it captured when it started.
 */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://api.example.test' },
}));
vi.mock('@/lib/api-client', () => ({ api: { routes: {} } }));

import type { Route } from '@/lib/schemas';
import {
  applyRouteMigrated,
  applyRouteRemoved,
  applyRouteSaved,
  applyRouteTransferred,
  cachedRouteVersion,
  routeKeys,
} from './use-routes';

const HC = 'example.com';
const LINK = 'links.example.com';

function route(overrides: Partial<Route> = {}): Route {
  return {
    path: '/talk',
    type: 'redirect',
    target: 'https://example.com/',
    enabled: true,
    updatedAt: 1000,
    ...overrides,
  };
}

function list(routes: Route[], invalid: Array<{ domain: string; path: string }> = []) {
  return {
    routes,
    invalidRoutes: invalid.map(row => ({ ...row, invalid: true as const })),
    total: routes.length + invalid.length,
    offset: 0,
    hasMore: false,
  };
}

type Listing = ReturnType<typeof list>;

/** A client holding the page's list of each domain and the all-domains list. */
function clientWithLists() {
  const client = new QueryClient();
  client.setQueryData(routeKeys.list(HC), list([route(), route({ path: '/other' })]));
  client.setQueryData(routeKeys.list(LINK), list([route({ updatedAt: 500 })]));
  client.setQueryData(
    routeKeys.list(),
    list([route({ domain: HC }), route({ domain: LINK, updatedAt: 500 })]),
  );
  return client;
}

const rows = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryData<Listing>(key)?.routes;

describe('a save writes its answer into every listing row of that domain and path', () => {
  it('replaces the row in the domain list and the all-domains list, keeping its domain', () => {
    const client = clientWithLists();
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ enabled: false, updatedAt: 2000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))?.[0]).toEqual(
      route({ enabled: false, updatedAt: 2000 }),
    );
    expect(rows(client, routeKeys.list())?.[0]).toEqual(
      route({ domain: HC, enabled: false, updatedAt: 2000 }),
    );
    expect(client.getQueryState(routeKeys.list(HC))?.isInvalidated).toBe(true);
  });

  it('leaves another domain, and another path, untouched', () => {
    const client = clientWithLists();
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 2000 }), 1000);
    expect(rows(client, routeKeys.list(LINK))).toEqual([route({ updatedAt: 500 })]);
    expect(rows(client, routeKeys.list())?.[1]).toEqual(route({ domain: LINK, updatedAt: 500 }));
    expect(rows(client, routeKeys.list(HC))?.[1]).toEqual(route({ path: '/other' }));
  });

  it('two saves from the same version answered in reverse order (3000, then 2000): the row keeps 3000', () => {
    const client = clientWithLists();
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ target: 'https://b.example/', updatedAt: 3000 }),
      1000,
    );
    // The late answer superseded 1000, which the row no longer is
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ target: 'https://a.example/', updatedAt: 2000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))?.[0]).toEqual(
      route({ target: 'https://b.example/', updatedAt: 3000 }),
    );
    expect(rows(client, routeKeys.list())?.[0]?.updatedAt).toBe(3000);
  });

  // v1.41.0 review: no clock orders two writes. The later write answered
  // first (2000); the earlier one, stamped by a faster clock, answers last
  // with a GREATER stamp (3000). The row is no longer the version it
  // superseded, so it stays; the refetch settles it
  it('two saves from the same version, the late answer stamped greater (2000, then 3000): the row keeps 2000', () => {
    const client = clientWithLists();
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ target: 'https://later.example/', updatedAt: 2000 }),
      1000,
    );
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ target: 'https://earlier.example/', updatedAt: 3000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))?.[0]).toEqual(
      route({ target: 'https://later.example/', updatedAt: 2000 }),
    );
    expect(rows(client, routeKeys.list())?.[0]?.updatedAt).toBe(2000);
    expect(client.getQueryState(routeKeys.list(HC))?.isInvalidated).toBe(true);
  });

  it('a row of another version is left for the refetch, even when the answer’s stamp is greater', () => {
    const client = new QueryClient();
    client.setQueryData(routeKeys.list(HC), list([route({ updatedAt: 1500 })]));
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 9000 }), 1000);
    expect(rows(client, routeKeys.list(HC))).toEqual([route({ updatedAt: 1500 })]);
  });

  it('an answer superseding the row’s version replaces it, even with the same stamp', () => {
    const client = clientWithLists();
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ enabled: false }), 1000);
    expect(rows(client, routeKeys.list(HC))?.[0]?.enabled).toBe(false);
  });

  // v1.41.0 review: the root cause removed. Workers isolates' clocks
  // disagree, so a later save can carry a SMALLER updatedAt than the row it
  // replaced; it superseded that row's version, so it is applied
  it('a later save whose server clock ran behind (smaller updatedAt) is applied', () => {
    const client = clientWithLists();
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 3000 }), 1000);
    // The next save was sent with expectedUpdatedAt 3000 and stamped 2500
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ enabled: false, updatedAt: 2500 }),
      3000,
    );
    expect(rows(client, routeKeys.list(HC))?.[0]).toEqual(
      route({ enabled: false, updatedAt: 2500 }),
    );
    expect(rows(client, routeKeys.list())?.[0]?.updatedAt).toBe(2500);
    // A late answer from the first save's era (it superseded 1000) is still rejected
    applyRouteSaved(
      client,
      { path: '/talk', domain: HC },
      route({ target: 'https://late.example/', updatedAt: 2000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))?.[0]).toEqual(
      route({ enabled: false, updatedAt: 2500 }),
    );
  });

  it('a search listing (rows carry their domain) is written too; a listing still loading is not', () => {
    const client = new QueryClient();
    client.setQueryData(
      routeKeys.search('talk'),
      list([route({ domain: HC }), route({ domain: LINK })]),
    );
    // A listing with no data yet (still loading): nothing to edit
    client.getQueryCache().build(client, { queryKey: routeKeys.list(LINK) });
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 2000 }), 1000);
    expect(rows(client, routeKeys.search('talk'))?.map(row => row.updatedAt)).toEqual([2000, 1000]);
    expect(client.getQueryData(routeKeys.list(LINK))).toBeUndefined();
  });

  // v1.41.0 review: Storage's "View in Routes" opens the editor from the
  // by-target row, so it must carry the saved updatedAt too
  it('writes a by-target answer’s row of that domain and path; a late older answer never', () => {
    const client = new QueryClient();
    const byTarget = routeKeys.byTarget('files', 'report.pdf');
    client.setQueryData(byTarget, [route({ domain: HC }), route({ domain: LINK })]);
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 2000 }), 1000);
    expect(client.getQueryData(byTarget)).toEqual([
      route({ domain: HC, updatedAt: 2000 }),
      route({ domain: LINK }),
    ]);
    // A late older answer never overwrites it
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 1500 }), 1000);
    expect(client.getQueryData<Route[]>(byTarget)?.[0]?.updatedAt).toBe(2000);
    expect(client.getQueryState(byTarget)?.isInvalidated).toBe(true);
  });

  it('leaves a route query that is neither a listing nor a by-target answer alone', () => {
    const client = new QueryClient();
    const other = ['routes', 'by-target', 'files', 'odd'];
    client.setQueryData(other, { unexpected: true });
    const single = ['routes', 'single', HC, '/talk'];
    client.setQueryData(single, route({ domain: HC }));
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 2000 }), 1000);
    expect(client.getQueryData(other)).toEqual({ unexpected: true });
    expect(client.getQueryData(single)).toEqual(route({ domain: HC }));
  });

  it('never matches a row with no domain in a listing with no domain filter', () => {
    const client = new QueryClient();
    client.setQueryData(routeKeys.list(), list([route()]));
    applyRouteSaved(client, { path: '/talk', domain: HC }, route({ updatedAt: 2000 }), 1000);
    expect(rows(client, routeKeys.list())).toEqual([route()]);
  });
});

describe('a migration', () => {
  it('the moved route takes the old row’s place; the total is unchanged', () => {
    const client = clientWithLists();
    applyRouteMigrated(
      client,
      { oldPath: '/talk', domain: HC },
      route({ path: '/new', updatedAt: 2000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))?.map(row => row.path)).toEqual(['/new', '/other']);
    expect(client.getQueryData<Listing>(routeKeys.list(HC))?.total).toBe(2);
    expect(rows(client, routeKeys.list())?.[0]).toEqual(
      route({ path: '/new', domain: HC, updatedAt: 2000 }),
    );
    expect(rows(client, routeKeys.list(LINK))).toEqual([route({ updatedAt: 500 })]);
  });

  // v1.41.0 review: the row already at the new path is not a version this
  // migration superseded, and no clock says which is newer, so it is left for
  // the refetch whatever its stamp; the superseded old row still goes
  it('leaves a row already at the new path for the refetch and removes the old one', () => {
    const client = new QueryClient();
    client.setQueryData(
      routeKeys.list(HC),
      list([route(), route({ path: '/new', updatedAt: 10 })]),
    );
    applyRouteMigrated(
      client,
      { oldPath: '/talk', domain: HC },
      route({ path: '/new', updatedAt: 2000 }),
      1000,
    );
    const listing = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(listing?.routes).toEqual([route({ path: '/new', updatedAt: 10 })]);
    expect(listing?.total).toBe(1);
    expect(client.getQueryState(routeKeys.list(HC))?.isInvalidated).toBe(true);
  });

  it('a move whose server clock ran behind (smaller updatedAt) still replaces the version it superseded', () => {
    const client = clientWithLists();
    applyRouteMigrated(
      client,
      { oldPath: '/talk', domain: HC },
      route({ path: '/new', updatedAt: 400 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))?.map(row => row.path)).toEqual(['/new', '/other']);
  });

  it('keeps an old-path row that is neither the version moved nor older (a later route there)', () => {
    const client = new QueryClient();
    client.setQueryData(routeKeys.list(HC), list([route({ updatedAt: 5000 })]));
    applyRouteMigrated(
      client,
      { oldPath: '/talk', domain: HC },
      route({ path: '/new', updatedAt: 2000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))).toEqual([route({ updatedAt: 5000 })]);
  });

  it('a listing without the old row gains no row', () => {
    const client = new QueryClient();
    client.setQueryData(routeKeys.list(HC), list([route({ path: '/other' })]));
    applyRouteMigrated(
      client,
      { oldPath: '/talk', domain: HC },
      route({ path: '/new', updatedAt: 2000 }),
      1000,
    );
    expect(rows(client, routeKeys.list(HC))).toEqual([route({ path: '/other' })]);
  });

  it('to the same path is a save', () => {
    const client = clientWithLists();
    applyRouteMigrated(client, { oldPath: '/talk', domain: HC }, route({ updatedAt: 2000 }), 1000);
    expect(rows(client, routeKeys.list(HC))?.[0]?.updatedAt).toBe(2000);
  });
});

describe('a delete', () => {
  it('removes the row of that domain only, and lowers each listing’s total', () => {
    const client = clientWithLists();
    applyRouteRemoved(client, { path: '/talk', domain: HC }, 1000);
    const listing = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(listing?.routes.map(row => row.path)).toEqual(['/other']);
    expect(listing?.total).toBe(1);
    expect(rows(client, routeKeys.list())).toEqual([route({ domain: LINK, updatedAt: 500 })]);
    expect(client.getQueryData<Listing>(routeKeys.list())?.total).toBe(1);
    expect(rows(client, routeKeys.list(LINK))).toEqual([route({ updatedAt: 500 })]);
    expect(client.getQueryState(routeKeys.list(LINK))?.isInvalidated).toBe(true);
  });

  it('an unreadable record’s recovery delete removes its unreadable row, not a route', () => {
    const client = new QueryClient();
    client.setQueryData(
      routeKeys.list(HC),
      list(
        [route({ path: '/ok' })],
        [
          { domain: HC, path: '/broken' },
          { domain: LINK, path: '/broken' },
        ],
      ),
    );
    applyRouteRemoved(
      client,
      { path: '/broken', domain: HC, recoverInvalid: true },
      Number.NEGATIVE_INFINITY,
    );
    const listing = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(listing?.invalidRoutes).toEqual([{ domain: LINK, path: '/broken', invalid: true }]);
    expect(listing?.routes).toEqual([route({ path: '/ok' })]);
    expect(listing?.total).toBe(2);
  });

  it('a listing that did not hold the row is not written', () => {
    const client = new QueryClient();
    client.setQueryData(routeKeys.list(LINK), list([route()]));
    const before = client.getQueryData(routeKeys.list(LINK));
    applyRouteRemoved(client, { path: '/talk', domain: HC }, 1000);
    expect(client.getQueryData(routeKeys.list(LINK))).toBe(before);
  });

  // v1.41.0 review: the delete's answer can land after the route was
  // re-created at that path (elsewhere) and the listings refetched. Only the
  // version the delete removed (read when it started) goes
  it('a delayed delete after a re-create keeps the newer row and the total', () => {
    const client = clientWithLists();
    const removedUpdatedAt = cachedRouteVersion(client, HC, '/talk');
    expect(removedUpdatedAt).toBe(1000);
    // Re-created and refetched before the delete's answer lands
    client.setQueryData(
      routeKeys.list(HC),
      list([route({ updatedAt: 3000 }), route({ path: '/other' })]),
    );
    applyRouteRemoved(client, { path: '/talk', domain: HC }, removedUpdatedAt);
    const listing = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(listing?.routes.map(row => row.updatedAt)).toEqual([3000, 1000]);
    expect(listing?.total).toBe(2);
    // A listing not refetched yet still loses the deleted version
    expect(rows(client, routeKeys.list())).toEqual([route({ domain: LINK, updatedAt: 500 })]);
  });

  // v1.41.0 review: the re-created route was stamped by a SLOWER clock, so
  // its updatedAt is smaller than the version the delete captured. It is
  // not that version, so it stays
  it('a delayed delete after a re-create stamped by a slower clock (900 < 1000) keeps the row and the total', () => {
    const client = clientWithLists();
    const removedUpdatedAt = cachedRouteVersion(client, HC, '/talk');
    client.setQueryData(
      routeKeys.list(HC),
      list([route({ updatedAt: 900 }), route({ path: '/other' })]),
    );
    applyRouteRemoved(client, { path: '/talk', domain: HC }, removedUpdatedAt);
    const listing = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(listing?.routes.map(row => row.updatedAt)).toEqual([900, 1000]);
    expect(listing?.total).toBe(2);
  });

  it('a row of another version than the one captured (a stale listing) is left for the refetch', () => {
    const client = clientWithLists();
    client.setQueryData(routeKeys.search('talk'), list([route({ domain: HC, updatedAt: 800 })]));
    applyRouteRemoved(client, { path: '/talk', domain: HC }, 1000);
    expect(rows(client, routeKeys.list(HC))?.map(row => row.path)).toEqual(['/other']);
    expect(rows(client, routeKeys.search('talk'))).toEqual([route({ domain: HC, updatedAt: 800 })]);
    expect(client.getQueryState(routeKeys.search('talk'))?.isInvalidated).toBe(true);
  });

  it('the version read at mutate time is the newest any listing holds; none: -Infinity', () => {
    const client = clientWithLists();
    client.setQueryData(routeKeys.byTarget('files', 'a.pdf'), [
      route({ domain: HC, updatedAt: 1200 }),
    ]);
    expect(cachedRouteVersion(client, HC, '/talk')).toBe(1200);
    expect(cachedRouteVersion(client, LINK, '/talk')).toBe(500);
    expect(cachedRouteVersion(client, HC, '/absent')).toBe(Number.NEGATIVE_INFINITY);
    // With nothing cached at mutate time, only a row with no timestamp goes
    client.setQueryData(
      routeKeys.list(HC),
      list([route({ path: '/absent', updatedAt: undefined })]),
    );
    applyRouteRemoved(client, { path: '/absent', domain: HC }, Number.NEGATIVE_INFINITY);
    expect(rows(client, routeKeys.list(HC))).toEqual([]);
  });

  it('removes the row from a by-target answer too', () => {
    const client = new QueryClient();
    const byTarget = routeKeys.byTarget('files', 'report.pdf');
    client.setQueryData(byTarget, [route({ domain: HC }), route({ domain: LINK })]);
    applyRouteRemoved(client, { path: '/talk', domain: HC }, 1000);
    expect(client.getQueryData(byTarget)).toEqual([route({ domain: LINK })]);
  });
});

describe('a transfer (v1.41.0 review)', () => {
  const variables = { path: '/talk', fromDomain: HC, toDomain: LINK };
  const answer = route({ updatedAt: 2000 });

  /** HC's list holds the route; LINK's holds another path; the all-domains list holds it on HC. */
  function clientForTransfer() {
    const client = new QueryClient();
    client.setQueryData(routeKeys.list(HC), list([route(), route({ path: '/other' })]));
    client.setQueryData(routeKeys.list(LINK), list([route({ path: '/kept' })]));
    client.setQueryData(
      routeKeys.list(),
      list([route({ domain: HC }), route({ domain: LINK, path: '/kept' })]),
    );
    return client;
  }

  it('an all-domains list keeps the row, now on the destination domain, and its total', () => {
    const client = clientForTransfer();
    applyRouteTransferred(client, variables, answer, 1000);
    const all = client.getQueryData<Listing>(routeKeys.list());
    expect(all?.routes).toEqual([
      route({ domain: LINK, updatedAt: 2000 }),
      route({ domain: LINK, path: '/kept' }),
    ]);
    expect(all?.total).toBe(2);
  });

  it('a search and a by-target answer rewrite the row’s domain too', () => {
    const client = new QueryClient();
    client.setQueryData(routeKeys.search('talk'), list([route({ domain: HC })]));
    const byTarget = routeKeys.byTarget('files', 'report.pdf');
    client.setQueryData(byTarget, [route({ domain: HC })]);
    applyRouteTransferred(client, variables, answer, 1000);
    expect(rows(client, routeKeys.search('talk'))).toEqual([
      route({ domain: LINK, updatedAt: 2000 }),
    ]);
    expect(client.getQueryData<Listing>(routeKeys.search('talk'))?.total).toBe(1);
    expect(client.getQueryData(byTarget)).toEqual([route({ domain: LINK, updatedAt: 2000 })]);
  });

  it('the source domain’s list loses the row; the destination’s is left to the refetch', () => {
    const client = clientForTransfer();
    const destination = client.getQueryData(routeKeys.list(LINK));
    applyRouteTransferred(client, variables, answer, 1000);
    const source = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(source?.routes.map(row => row.path)).toEqual(['/other']);
    expect(source?.total).toBe(1);
    // v1.41.0 review: never inserted into a destination page, whose order
    // and membership are the server's; the invalidation refetches it
    expect(client.getQueryData(routeKeys.list(LINK))).toBe(destination);
    expect(client.getQueryState(routeKeys.list(LINK))?.isInvalidated).toBe(true);
  });

  it('no destination listing is written: a first page, a prefetch, a search or a later page', () => {
    const client = new QueryClient();
    const keys = [
      routeKeys.list(LINK),
      routeKeys.list(LINK, undefined, 1000),
      routeKeys.list(LINK, 'talk'),
      routeKeys.list(LINK, undefined, 50, 50),
    ];
    for (const key of keys) client.setQueryData(key, list([route({ updatedAt: 1500 })]));
    const before = keys.map(key => client.getQueryData(key));
    applyRouteTransferred(client, variables, answer, 1000);
    expect(keys.map(key => client.getQueryData(key))).toEqual(before);
    for (const [index, key] of keys.entries()) {
      expect(client.getQueryData(key)).toBe(before[index]);
    }
  });

  it('a listing with no domain filter that already lists the route on the destination drops the source row', () => {
    const client = new QueryClient();
    client.setQueryData(
      routeKeys.list(),
      list([route({ domain: HC }), route({ domain: LINK, updatedAt: 1500 })]),
    );
    applyRouteTransferred(client, variables, answer, 1000);
    const all = client.getQueryData<Listing>(routeKeys.list());
    expect(all?.routes).toEqual([route({ domain: LINK, updatedAt: 1500 })]);
    expect(all?.total).toBe(1);
  });

  it('a source row newer than the version moved (re-created there) stays, the total unchanged', () => {
    const client = clientForTransfer();
    client.setQueryData(
      routeKeys.list(HC),
      list([route({ updatedAt: 3000 }), route({ path: '/other' })]),
    );
    applyRouteTransferred(client, variables, answer, 1000);
    const source = client.getQueryData<Listing>(routeKeys.list(HC));
    expect(source?.routes.map(row => row.updatedAt)).toEqual([3000, 1000]);
    expect(source?.total).toBe(2);
  });

  // v1.41.0 review: re-created there and refetched with a SMALLER stamp
  // (900) from a slower clock. Not the version moved: in an unfiltered
  // listing it is neither removed nor replaced by the moved route
  it('a source row re-created with a smaller stamp stays in an unfiltered listing, never replaced by the moved route', () => {
    const client = clientForTransfer();
    client.setQueryData(
      routeKeys.list(),
      list([route({ domain: HC, updatedAt: 900 }), route({ domain: LINK, path: '/kept' })]),
    );
    client.setQueryData(
      routeKeys.list(HC),
      list([route({ updatedAt: 900 }), route({ path: '/other' })]),
    );
    const before = client.getQueryData(routeKeys.list());
    applyRouteTransferred(client, variables, answer, 1000);
    expect(client.getQueryData(routeKeys.list())).toBe(before);
    const all = client.getQueryData<Listing>(routeKeys.list());
    expect(all?.routes).toEqual([
      route({ domain: HC, updatedAt: 900 }),
      route({ domain: LINK, path: '/kept' }),
    ]);
    expect(all?.total).toBe(2);
    expect(rows(client, routeKeys.list(HC))?.map(row => row.updatedAt)).toEqual([900, 1000]);
  });
});
