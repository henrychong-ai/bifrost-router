import { bench, describe } from 'vitest';
import { lookupRoute } from '../../src/kv/lookup';
import { routeKey } from '../../src/kv/schema';
import type { KVRouteConfig } from '../../src/types';
import { DEEP_PATH, DEEP_PATH_WILDCARD_CANDIDATES } from './route-lookup-fixture';

const DOMAIN = 'benchmark.example.com';
const READ_LATENCY_MS = 2;
const BENCH_OPTIONS = { time: 1_000, warmupTime: 200 };

const exactRoute: KVRouteConfig = {
  path: DEEP_PATH,
  type: 'redirect',
  target: 'https://example.com/exact',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const rootWildcardRoute: KVRouteConfig = {
  path: '/*',
  type: 'redirect',
  target: 'https://example.com/wildcard',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

function createLatencyModel(routes: ReadonlyMap<string, KVRouteConfig>): KVNamespace {
  return {
    async get(key: string) {
      await scheduler.wait(READ_LATENCY_MS);
      // KV values are read as text and parsed by the lookup
      const route = routes.get(key);
      return route === undefined ? null : JSON.stringify(route);
    },
  } as unknown as KVNamespace;
}

const exactHitKv = createLatencyModel(new Map([[routeKey(DOMAIN, DEEP_PATH), exactRoute]]));
const rootWildcardHitKv = createLatencyModel(
  new Map([[routeKey(DOMAIN, '/*'), rootWildcardRoute]]),
);
const missKv = createLatencyModel(new Map());

/**
 * The reference passes (v1.40.0): the latency model's own cost, with no
 * lookup logic, measured in the same run as the lookups. The gate
 * (scripts/check-routing-benchmark.mjs) compares each lookup with its
 * reference, so machine load slows both sides alike. One read is the exact
 * key; two rounds are the exact key, then every wildcard candidate in
 * parallel, as a deep lookup that falls through to the wildcards reads them.
 * A lookup that reads more rounds than its reference, or spends more time
 * between reads, still shows as a regression.
 *
 * The candidates are written out here, never taken from the code under test
 * (getWildcardCandidates), so a lookup that reads more candidates slows only
 * its own side; test/kv/lookup.test.ts pins the lookup's list to these
 * (route-lookup-fixture.ts).
 */
const exactKey = routeKey(DOMAIN, DEEP_PATH);
const wildcardKeys = DEEP_PATH_WILDCARD_CANDIDATES.map(path => routeKey(DOMAIN, path));

describe(`route lookup with ${READ_LATENCY_MS} ms per KV read`, () => {
  bench(
    'deep exact hit',
    async () => {
      await lookupRoute(exactHitKv, DOMAIN, DEEP_PATH);
    },
    BENCH_OPTIONS,
  );

  bench(
    'deep root-wildcard hit',
    async () => {
      await lookupRoute(rootWildcardHitKv, DOMAIN, DEEP_PATH);
    },
    BENCH_OPTIONS,
  );

  bench(
    'deep miss',
    async () => {
      await lookupRoute(missKv, DOMAIN, DEEP_PATH);
    },
    BENCH_OPTIONS,
  );

  bench(
    'reference: one KV read',
    async () => {
      await missKv.get(exactKey);
    },
    BENCH_OPTIONS,
  );

  bench(
    'reference: two KV rounds',
    async () => {
      await missKv.get(exactKey);
      await Promise.all(wildcardKeys.map(key => missKv.get(key)));
    },
    BENCH_OPTIONS,
  );
});
