/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_DOMAINS as WORKER_DOMAINS } from '../src/types';
import sharedSource from '../shared/src/types.ts?raw';
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
  it('shared/src/types.ts matches src/types.ts', () => {
    expect(parseSupportedDomains(sharedSource, 'shared/src/types.ts')).toEqual([...WORKER_DOMAINS]);
  });

  it('admin/src/context/filter-types.ts matches src/types.ts', () => {
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
  });
});
