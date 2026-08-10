import { bench, describe } from 'vitest';
import { matchRoute } from '../../src/kv/lookup';
import { routeKey } from '../../src/kv/schema';
import type { KVRouteConfig } from '../../src/types';

const DOMAIN = 'benchmark.example.com';
const DEEP_PATH = '/a/b/c/d/e/f/g/h';
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
      return routes.get(key) ?? null;
    },
  } as unknown as KVNamespace;
}

const exactHitKv = createLatencyModel(new Map([[routeKey(DOMAIN, DEEP_PATH), exactRoute]]));
const rootWildcardHitKv = createLatencyModel(
  new Map([[routeKey(DOMAIN, '/*'), rootWildcardRoute]]),
);
const missKv = createLatencyModel(new Map());

describe(`route lookup with ${READ_LATENCY_MS} ms per KV read`, () => {
  bench(
    'deep exact hit',
    async () => {
      await matchRoute(exactHitKv, DOMAIN, DEEP_PATH);
    },
    BENCH_OPTIONS,
  );

  bench(
    'deep root-wildcard hit',
    async () => {
      await matchRoute(rootWildcardHitKv, DOMAIN, DEEP_PATH);
    },
    BENCH_OPTIONS,
  );

  bench(
    'deep miss',
    async () => {
      await matchRoute(missKv, DOMAIN, DEEP_PATH);
    },
    BENCH_OPTIONS,
  );
});
