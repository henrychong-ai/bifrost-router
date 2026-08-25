import { describe, it, expect } from 'vitest';
import { SUPPORTED_DOMAINS as SHARED_SUPPORTED_DOMAINS } from '@bifrost/shared';
import { DEFAULT_FILTERS, SUPPORTED_DOMAINS, type PageKey } from './filter-types';

/**
 * Value-parity guard for the dashboard's Domain dropdown.
 *
 * The dashboard keeps its own hardcoded `SUPPORTED_DOMAINS` copy (step 3 of the
 * "Adding a New Supported Domain" checklist). The Worker-side drift test parses
 * this file's SOURCE TEXT with a regex, which cannot see what the module
 * actually exports — a domain added through a spread, a re-export, or a
 * conditional would satisfy the regex and still ship the wrong dropdown. This
 * asserts the RUNTIME values, in exact order, against `@bifrost/shared`.
 */
describe('dashboard SUPPORTED_DOMAINS parity', () => {
  it('mirrors @bifrost/shared exactly and in order', () => {
    expect([...SUPPORTED_DOMAINS]).toEqual([...SHARED_SUPPORTED_DOMAINS]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(SUPPORTED_DOMAINS).size).toBe(SUPPORTED_DOMAINS.length);
  });
});

describe('DEFAULT_FILTERS', () => {
  it('defaults the analytics pages to a 1-day window and audit to 30 days', () => {
    expect(DEFAULT_FILTERS.redirects.days).toBe(1);
    expect(DEFAULT_FILTERS.views.days).toBe(1);
    expect(DEFAULT_FILTERS.downloads.days).toBe(1);
    expect(DEFAULT_FILTERS.proxy.days).toBe(1);
    expect(DEFAULT_FILTERS.audit.days).toBe(30);
  });

  it('applies no domain filter on any page by default', () => {
    // A default domain would silently hide every other domain's data behind a
    // filter the operator never set.
    for (const page of Object.keys(DEFAULT_FILTERS) as PageKey[]) {
      expect(
        (DEFAULT_FILTERS[page] as { domain?: string }).domain,
        `${page} must not default to a domain filter`,
      ).toBeUndefined();
    }
  });

  it('covers every page key exactly once', () => {
    expect(Object.keys(DEFAULT_FILTERS).sort()).toEqual([
      'audit',
      'downloads',
      'proxy',
      'redirects',
      'routes',
      'views',
    ]);
  });
});
