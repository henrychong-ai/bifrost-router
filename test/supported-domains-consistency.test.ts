/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_DOMAINS as SHARED_DOMAINS } from '@bifrost/shared';
import { SUPPORTED_DOMAINS as WORKER_DOMAINS } from '../src/types';
import adminSource from '../admin/src/context/filter-types.ts?raw';
import openapiSource from '../openapi/bifrost-api.yaml?raw';

/**
 * Drift-detection test for SUPPORTED_DOMAINS.
 *
 * Three hardcoded copies of SUPPORTED_DOMAINS must stay in sync:
 * 1. src/types.ts                      — Worker-side route validation
 * 2. shared/src/types.ts               — MCP tool enums + admin form schemas
 * 3. admin/src/context/filter-types.ts — Dashboard Domain filter dropdown
 *
 * The OpenAPI DomainQuery enum must also match (API Shield blocks unknown values).
 *
 * See CLAUDE.md "Adding a New Supported Domain" checklist.
 *
 * Every assertion here compares the SAME ordered list. Copies 1 and 2 are
 * compared as runtime VALUES — the shared package is a real module here, and
 * source-text parsing cannot see what a module actually exports. Copy 3 is a
 * browser module (`@/` aliases, no workerd resolution), so it is compared by
 * source text here and again as runtime values in the dashboard's own
 * `admin/src/context/filter-types.test.ts`; the OpenAPI enum is YAML with no
 * runtime form at all.
 */

function parseSupportedDomains(source: string, label: string): string[] {
  const match = source.match(/export const SUPPORTED_DOMAINS = \[([\s\S]*?)\] as const/);
  if (!match) {
    throw new Error(`SUPPORTED_DOMAINS declaration not found in ${label}`);
  }
  return match[1]
    .split('\n')
    .map(line => line.match(/'([^']+)'/)?.[1])
    .filter((d): d is string => Boolean(d));
}

describe('SUPPORTED_DOMAINS consistency', () => {
  it('@bifrost/shared matches src/types.ts (runtime values, exact order)', () => {
    expect([...SHARED_DOMAINS]).toEqual([...WORKER_DOMAINS]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(WORKER_DOMAINS).size).toBe(WORKER_DOMAINS.length);
  });

  it('admin/src/context/filter-types.ts matches src/types.ts', () => {
    // Source-text guard only — the runtime-value equivalent runs in the
    // dashboard suite (admin/src/context/filter-types.test.ts), which can
    // import the module through its `@/` alias. Both assert the same ordered
    // list, so they cannot disagree.
    expect(parseSupportedDomains(adminSource, 'admin/src/context/filter-types.ts')).toEqual([
      ...WORKER_DOMAINS,
    ]);
  });

  it('openapi/bifrost-api.yaml DomainQuery enum matches src/types.ts', () => {
    const match = openapiSource.match(/DomainQuery:[\s\S]*?enum:([\s\S]*?)(?=\n {4}\w|\n\w)/);
    if (!match) throw new Error('DomainQuery enum not found in openapi/bifrost-api.yaml');
    const enumDomains = match[1]
      .split('\n')
      .map(line => line.match(/^\s*-\s+(\S+)/)?.[1])
      .filter((d): d is string => Boolean(d));
    expect(enumDomains.sort()).toEqual([...WORKER_DOMAINS].sort());
    expect(enumDomains).toHaveLength(WORKER_DOMAINS.length);
  });
});
