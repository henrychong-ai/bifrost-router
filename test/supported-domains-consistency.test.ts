/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */

import { SUPPORTED_DOMAINS as SHARED_DOMAINS } from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import adminSource from '../admin/src/context/filter-types.ts?raw';
import openapiSource from '../openapi/bifrost-api.yaml?raw';
import { SUPPORTED_DOMAINS as WORKER_DOMAINS } from '../src/types';

/**
 * Drift-detection test for SUPPORTED_DOMAINS.
 *
 * Three hardcoded copies of SUPPORTED_DOMAINS must stay in sync:
 * 1. src/types.ts                      — Worker-side route validation
 * 2. shared/src/types.ts               — MCP tool enums + admin form schemas
 * 3. admin/src/context/filter-types.ts — Dashboard Domain filter dropdown
 *
 * Every OpenAPI DomainQuery* enum (read and write) must also match (API
 * Shield blocks unknown values).
 *
 * See AGENTS.md "Adding a New Supported Domain" checklist.
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

/** Every `*DomainQuery*` parameter under components/parameters, with its enum. */
function openapiDomainEnums(): Map<string, string[]> {
  const parameters = openapiSource.slice(openapiSource.indexOf('\n  parameters:\n'));
  const enums = new Map<string, string[]>();
  for (const match of parameters.matchAll(
    /\n {4}(\w*DomainQuery\w*):\n([\s\S]*?)(?=\n {4}\w|\n {2}\w|\n\w)/g,
  )) {
    const body = match[2] ?? '';
    const list = body.slice(body.indexOf('enum:'));
    enums.set(
      match[1] ?? '',
      list
        .split('\n')
        .map(line => line.match(/^\s*-\s+(\S+)/)?.[1])
        .filter((d): d is string => Boolean(d)),
    );
  }
  return enums;
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

  it('openapi/bifrost-api.yaml: every DomainQuery* enum matches src/types.ts, in order', () => {
    const enums = openapiDomainEnums();
    // The read parameter and the write parameter (explicit domain on writes)
    expect([...enums.keys()].toSorted()).toEqual(['DomainQuery', 'DomainQueryWrite']);
    for (const [name, domains] of enums) {
      expect({ name, domains }).toEqual({ name, domains: [...WORKER_DOMAINS] });
    }
  });
});
