/**
 * The routing benchmark's deep path and the wildcard candidates its reference
 * pass reads (v1.40.0), written out rather than taken from the code under
 * test, so a lookup that reads more candidates slows only its own side of the
 * gate (scripts/check-routing-benchmark.mjs). test/kv/lookup.test.ts checks
 * that getWildcardCandidates still gives exactly these.
 */
export const DEEP_PATH = '/a/b/c/d/e/f/g/h';

export const DEEP_PATH_WILDCARD_CANDIDATES = [
  '/a/b/c/d/e/f/g/*',
  '/a/b/c/d/e/f/*',
  '/a/b/c/d/e/*',
  '/a/b/c/d/*',
  '/a/b/c/*',
  '/a/b/*',
  '/a/*',
  '/*',
] as const;
