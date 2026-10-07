import { describe, expect, it } from 'vitest';
import { allStrings, growthRatio, LINEAR_GROWTH_LIMIT } from './linear.test-support.js';
import {
  dropDashesAroundDots,
  isNormalizedR2Key,
  isServableR2Key,
  normalizeR2Key,
  sanitizeR2Key,
  trimTrailingSlashes,
} from './r2-key.js';

describe('normalizeR2Key', () => {
  it('lowercases', () => {
    expect(normalizeR2Key('Report.PDF')).toBe('report.pdf');
    expect(normalizeR2Key('IMG_1234.JPG')).toBe('img_1234.jpg');
  });

  it('replaces whitespace with a single hyphen', () => {
    expect(normalizeR2Key('My Report.pdf')).toBe('my-report.pdf');
    expect(normalizeR2Key('a   b   c.txt')).toBe('a-b-c.txt');
    expect(normalizeR2Key('tab\tseparated.csv')).toBe('tab-separated.csv');
  });

  it('preserves / as the subdir separator and normalizes per segment', () => {
    expect(normalizeR2Key('Photos/My Report.PDF')).toBe('photos/my-report.pdf');
    expect(normalizeR2Key('A/B C/D.png')).toBe('a/b-c/d.png');
  });

  it('drops empty segments (collapses //, trims leading/trailing /)', () => {
    expect(normalizeR2Key('a//b.txt')).toBe('a/b.txt');
    expect(normalizeR2Key('/leading/x.txt')).toBe('leading/x.txt');
    expect(normalizeR2Key('trailing/x.txt/')).toBe('trailing/x.txt');
  });

  it('replaces URL-noisy specials with hyphens and tidies around the extension', () => {
    expect(normalizeR2Key('Report (v2).pdf')).toBe('report-v2.pdf');
    expect(normalizeR2Key('A&B, C+D@E#1.pdf')).toBe('a-b-c-d-e-1.pdf');
    expect(normalizeR2Key('100% done.txt')).toBe('100-done.txt');
  });

  it('preserves interior dots, underscores, and existing hyphens (legit filenames)', () => {
    expect(normalizeR2Key('archive.tar.gz')).toBe('archive.tar.gz');
    expect(normalizeR2Key('my_file-name.v2.json')).toBe('my_file-name.v2.json');
  });

  it('collapses repeated separators and trims edges', () => {
    expect(normalizeR2Key('--Weird__ Name--.PDF')).toBe('weird__-name.pdf');
    expect(normalizeR2Key('...dots...txt')).toBe('dots.txt');
  });

  it('is idempotent', () => {
    const inputs = [
      'My Report (v2).PDF',
      'Photos/A & B/Final, v3.png',
      'archive.tar.gz',
      '100% done!.txt',
    ];
    for (const input of inputs) {
      const once = normalizeR2Key(input);
      expect(normalizeR2Key(once)).toBe(once);
    }
  });

  it('transliterates accented Latin to ASCII (NFKD + strip diacritics)', () => {
    expect(normalizeR2Key('café.png')).toBe('cafe.png');
    expect(normalizeR2Key('Résumé.PDF')).toBe('resume.pdf');
    expect(normalizeR2Key('Übersicht/naïve.txt')).toBe('ubersicht/naive.txt');
  });

  it('stays SAFE on fullwidth/Unicode that decomposes to ASCII dots/slashes', () => {
    // Fullwidth dots/slashes NFKD-decompose to ASCII '.' / '/', but per-segment
    // processing (split happens first) + collapse/trim must NOT yield a traversal,
    // a leading dot, or a path separator.
    const out = normalizeR2Key('．．／etc／passwd');
    expect(out).not.toContain('..');
    expect(out.startsWith('/')).toBe(false);
    expect(out.startsWith('.')).toBe(false);
    expect(out).not.toContain('//');
  });

  it('leaves an already-clean key unchanged', () => {
    expect(normalizeR2Key('images/logos/logo.png')).toBe('images/logos/logo.png');
    expect(normalizeR2Key('my-file.pdf')).toBe('my-file.pdf');
  });

  it('can normalize to empty when the input has no usable chars', () => {
    expect(normalizeR2Key('   ')).toBe('');
    expect(normalizeR2Key('***')).toBe('');
  });
});

describe('isNormalizedR2Key', () => {
  it('is true for already-clean keys, false otherwise', () => {
    expect(isNormalizedR2Key('images/my-file.pdf')).toBe(true);
    expect(isNormalizedR2Key('My File.PDF')).toBe(false);
    expect(isNormalizedR2Key('a//b.txt')).toBe(false);
  });
});

describe('isServableR2Key: the Worker rule for an r2 route target (v1.38.0)', () => {
  it('accepts an object key an r2 route can serve as it is', () => {
    for (const key of ['bio.pdf', 'docs/a.pdf', 'images/header.jpg', 'Report Q1.pdf']) {
      expect(isServableR2Key(key)).toBe(true);
    }
  });

  it('refuses a URL, a blank key and every key the Worker would sanitise', () => {
    for (const key of [
      'https://example.com/a.pdf',
      '',
      '   ',
      '/leading.pdf',
      'a/../b.pdf',
      'docs/.hidden',
      'a//b.pdf',
      'trailing/',
      'a\\b.pdf',
      'a?b.pdf',
    ]) {
      expect({ key, servable: isServableR2Key(key) }).toEqual({ key, servable: false });
    }
  });
});

// The pre-v1.39.0 body, verbatim, as the reference
function reference(key: string): string {
  let sanitized = key;
  // oxlint-disable-next-line no-control-regex -- the reference copies the original
  sanitized = sanitized.replace(/\x00/g, '');
  // oxlint-disable-next-line no-control-regex -- the reference copies the original
  sanitized = sanitized.replace(/[\x00-\x1f]/g, '');
  sanitized = sanitized.replace(/[<>:"|?*]/g, '');
  sanitized = sanitized.replace(/\\/g, '/');
  while (sanitized.includes('..')) sanitized = sanitized.replace(/\.\./g, '');
  sanitized = sanitized.replace(/^\/+/, '');
  sanitized = sanitized.replace(/\/+/g, '/');
  sanitized = sanitized.replace(/\/+$/, '');
  sanitized = sanitized.replace(/(?:^|\/)\.(?!\.)[^/]*/g, '');
  sanitized = sanitized.replace(/^\/+/, '');
  sanitized = sanitized.replace(/\/+/g, '/');
  return sanitized.replace(/\/+$/, '');
}

// v1.39.0: code scanning flagged `/\/+$/` as polynomial (alert #7)
describe('trimTrailingSlashes', () => {
  it('equals the regex it replaces on every short string', () => {
    for (const value of allStrings(['/', 'a', '.', '\n'], 6)) {
      expect(trimTrailingSlashes(value)).toBe(value.replace(/\/+$/, ''));
    }
  });

  it('is linear on a long run of slashes that does not end the string', () => {
    // The regex took about a second on 50,000 slashes and a letter
    expect(trimTrailingSlashes(`${'/'.repeat(1000)}x`)).toBe(`${'/'.repeat(1000)}x`);
    expect(trimTrailingSlashes(`x${'/'.repeat(1000)}`)).toBe('x');
    for (const input of [(n: number) => `${'/'.repeat(n)}x`, (n: number) => `x${'/'.repeat(n)}`]) {
      expect(growthRatio(trimTrailingSlashes, input)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }
  });

  it('leaves sanitizeR2Key equal to its regex form, and linear', () => {
    for (const key of allStrings(['/', 'a', '.', '\\', ':', '\u0001'], 6)) {
      expect(sanitizeR2Key(key)).toBe(reference(key));
    }
    expect(sanitizeR2Key(`a${'/'.repeat(1000)}b`)).toBe('a/b');
    expect(growthRatio(sanitizeR2Key, n => `a${'/'.repeat(n)}b`)).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });
});

/** normalizeR2Key as it was before v1.39.0, with the regexes code scanning flagged. */
function normalizeR2KeyReference(key: string): string {
  return key
    .split('/')
    .map(segment =>
      segment
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-*\.-*/g, '.')
        .replace(/-+/g, '-')
        .replace(/\.+/g, '.')
        .replace(/^[-.]+|[-.]+$/g, ''),
    )
    .filter(segment => segment.length > 0)
    .join('/');
}

// v1.39.0: `/-*\.-*/g` and `/^[-.]+|[-.]+$/g` in the segment normaliser are
// polynomial; both are linear scans now, with identical results
describe('normalizeR2Key linear scans', () => {
  it('dropDashesAroundDots equals the regex it replaces on every short string', () => {
    for (const value of allStrings(['-', '.', 'a'], 8)) {
      expect(dropDashesAroundDots(value)).toBe(value.replace(/-*\.-*/g, '.'));
    }
  });

  it('normalizeR2Key equals its regex form on every short string', () => {
    for (const key of allStrings(['-', '.', 'a', ' ', '/', '\u00c9'], 6)) {
      expect(normalizeR2Key(key)).toBe(normalizeR2KeyReference(key));
    }
    expect(normalizeR2Key('My Report -- Final .. v2 .PDF')).toBe(
      normalizeR2KeyReference('My Report -- Final .. v2 .PDF'),
    );
  });

  it('is linear on long runs of dashes and dots (growth ratio, not wall-clock)', () => {
    expect(normalizeR2Key(`${'-'.repeat(1000)}a`)).toBe('a');
    for (const input of [
      (n: number) => `${'-'.repeat(n)}a`,
      (n: number) => `a${'-.'.repeat(n / 2)}a`,
      (n: number) => `a${'.-'.repeat(n / 2)}`,
    ]) {
      expect(growthRatio(normalizeR2Key, input)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }
  });
});
