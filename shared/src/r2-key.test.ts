import { describe, it, expect } from 'vitest';
import { normalizeR2Key, isNormalizedR2Key } from './r2-key.js';

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
