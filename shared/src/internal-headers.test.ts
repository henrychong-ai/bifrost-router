import { describe, expect, it } from 'vitest';
import {
  INTERNAL_HEADER_NAMES,
  INTERNAL_HEADER_PREFIXES,
  isInternalHeader,
  KNOWN_INTERNAL_HEADERS,
} from './internal-headers';

describe('isInternalHeader', () => {
  it('names the admin key, X-Bifrost-* and Tailscale-User-* in any case', () => {
    for (const name of [
      'x-admin-key',
      'X-ADMIN-KEY',
      'X-Bifrost-Dashboard',
      'x-bifrost-anything',
      'Tailscale-User-Login',
      'TAILSCALE-USER-OTHER',
    ]) {
      expect([name, isInternalHeader(name)]).toEqual([name, true]);
    }
  });

  it('names nothing else', () => {
    for (const name of [
      'authorization',
      'x-admin-keys',
      'x-bifrostish',
      'tailscale-other',
      'x-forwarded-host',
      '',
    ]) {
      expect([name, isInternalHeader(name)]).toEqual([name, false]);
    }
  });

  it('covers every header the deployment itself uses', () => {
    expect(KNOWN_INTERNAL_HEADERS.filter(name => !isInternalHeader(name))).toEqual([]);
  });

  it('keeps its names and prefixes in lower case', () => {
    for (const value of [...INTERNAL_HEADER_NAMES, ...INTERNAL_HEADER_PREFIXES]) {
      expect(value).toBe(value.toLowerCase());
    }
  });
});
