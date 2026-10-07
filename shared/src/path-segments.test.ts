import { describe, expect, it } from 'vitest';
import { objectKeySegments, pathSegments, UNADDRESSABLE_OBJECT_KEY } from './path-segments';

/** What a server sees: the URL a client builds, its path decoded per segment. */
function roundTrip(value: string): string {
  const url = new URL(`/api/storage/files/objects/${pathSegments(value)}`, 'https://example.com');
  return url.pathname
    .slice('/api/storage/files/objects/'.length)
    .split('/')
    .map(decodeURIComponent)
    .join('/');
}

describe('pathSegments', () => {
  it('encodes each segment and keeps the slashes', () => {
    expect(pathSegments('docs/a b.pdf')).toBe('docs/a%20b.pdf');
    expect(pathSegments('/promo/summer')).toBe('promo/summer');
    expect(pathSegments('///promo')).toBe('promo');
    expect(pathSegments('/')).toBe('');
    expect(pathSegments('')).toBe('');
  });

  it('never lets #, ?, a backslash or a percent escape change the key', () => {
    for (const key of [
      'a#b',
      'docs/a#/b/c',
      'docs/a#..b/x',
      'a?b=1',
      'dir/a?x#y',
      'a\\b',
      'dir\\..\\x',
      'a%2eb',
      'dir/%2e%2e/x',
      'a%2Fb',
      'a%20b',
      "a!$&'()*+,;=:@b",
      'café/報告.pdf',
      'trailing/',
      'a//b',
    ]) {
      expect({ key, sent: roundTrip(key) }).toEqual({ key, sent: key.replace(/^\/+/, '') });
    }
    // No encoded slash: the dashboard's proxy refuses one
    expect(pathSegments('a/b%2Fc/d')).toBe('a/b%252Fc/d');
    expect(pathSegments('a\\b')).toBe('a%5Cb');
    expect(pathSegments('a#b?c')).toBe('a%23b%3Fc');
  });

  it('refuses a segment of only dots, which no URL can carry', () => {
    for (const key of ['.', '..', 'a/./b', 'a/../b', '../x', 'x/..', 'docs/a#/../../x']) {
      expect(() => pathSegments(key)).toThrow(RangeError);
    }
    // Dots inside a segment are fine
    expect(pathSegments('.hidden/a..b/...')).toBe('.hidden/a..b/...');
  });

  it('scans a long run of leading slashes in linear time', () => {
    expect(pathSegments(`${'/'.repeat(100_000)}x`)).toBe('x');
  });
});

/** What a server sees for an object key: the URL built, its path decoded per segment. */
function keyRoundTrip(key: string): string {
  const prefix = '/api/storage/files/objects/';
  const url = new URL(`${prefix}${objectKeySegments(key)}`, 'https://example.com');
  return url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
}

describe('objectKeySegments', () => {
  it('sends a normal key exactly, each segment encoded', () => {
    expect(objectKeySegments('docs/a b.pdf')).toBe('docs/a%20b.pdf');
    expect(objectKeySegments('report.pdf')).toBe('report.pdf');
    expect(objectKeySegments('a#b?c')).toBe('a%23b%3Fc');
    expect(objectKeySegments('a/b%2Fc/d')).toBe('a/b%252Fc/d');
    expect(objectKeySegments('a\\b')).toBe('a%5Cb');
    for (const key of [
      'a#b',
      'docs/a#/b/c',
      'a?b=1',
      'a\\b',
      'a%2eb',
      'dir/%2e%2e/x',
      'a%2Fb',
      "a!$&'()*+,;=:@b",
      'café/報告.pdf',
      '.hidden/a..b/...',
    ]) {
      expect({ key, sent: keyRoundTrip(key) }).toEqual({ key, sent: key });
    }
  });

  it('refuses a leading slash rather than dropping it (it would address another key)', () => {
    for (const key of ['/report.pdf', '//report.pdf', '/', '/a/b']) {
      expect(() => objectKeySegments(key)).toThrow(new RangeError(UNADDRESSABLE_OBJECT_KEY));
    }
    // The route-path rule drops it; keys never go through that rule
    expect(pathSegments('/report.pdf')).toBe('report.pdf');
  });

  it('refuses an empty segment: a//b, a trailing slash, the empty key', () => {
    for (const key of ['a//b', 'a/', '', 'a///b/c']) {
      expect(() => objectKeySegments(key)).toThrow(RangeError);
    }
  });

  it('refuses a segment of only dots', () => {
    for (const key of ['.', '..', 'a/./b', 'a/../b', '../x', 'x/..']) {
      expect(() => objectKeySegments(key)).toThrow(RangeError);
    }
  });

  it('names no key in its error', () => {
    expect(() => objectKeySegments('/secret-name.pdf')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-name') }),
    );
  });
});
