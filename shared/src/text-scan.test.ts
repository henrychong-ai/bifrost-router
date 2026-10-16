import { describe, expect, it } from 'vitest';
import { hasLoneSurrogate, replaceLoneSurrogates } from './text-scan.js';

/** Every string over `alphabet` up to `maxLength` characters. */
function* strings(alphabet: readonly string[], maxLength: number): Generator<string> {
  let layer = [''];
  yield '';
  for (let length = 1; length <= maxLength; length += 1) {
    const next: string[] = [];
    for (const prefix of layer) {
      for (const unit of alphabet) {
        const value = prefix + unit;
        next.push(value);
        yield value;
      }
    }
    layer = next;
  }
}

const SURROGATE_ALPHABET = ['a', '\ud83d', '\ude00', '\udbff', '\udc00'] as const;

/** encodeURIComponent throws URIError on exactly the strings with an unpaired surrogate. */
function malformed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return false;
  } catch {
    return true;
  }
}

/** What a TextEncoder round trip makes of `value`: U+FFFD for each unpaired surrogate. */
function roundTrip(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value));
}

describe('hasLoneSurrogate (v1.42.1)', () => {
  it('agrees with encodeURIComponent for every short string of a, high and low surrogates', () => {
    for (const value of strings(SURROGATE_ALPHABET, 6)) {
      expect(hasLoneSurrogate(value)).toBe(malformed(value));
    }
  });

  it('accepts ASCII, BMP and astral text, refuses each unpaired form', () => {
    expect(hasLoneSurrogate('')).toBe(false);
    expect(hasLoneSurrogate('BEGIN:VCARD \u0080 ࠀ ￿ 😀 \u{10ffff}')).toBe(false);
    expect(hasLoneSurrogate('\ud800')).toBe(true);
    expect(hasLoneSurrogate('\udfff')).toBe(true);
    expect(hasLoneSurrogate('a\ude00\ud83d')).toBe(true);
  });

  it('is linear: a long run of surrogates is scanned once', () => {
    const long = '😀'.repeat(200_000);
    expect(hasLoneSurrogate(long)).toBe(false);
    expect(hasLoneSurrogate(`${long}\ud83d`)).toBe(true);
  });
});

describe('replaceLoneSurrogates (v1.42.1)', () => {
  it('agrees with a TextEncoder round trip for every short string of a, high and low surrogates', () => {
    for (const value of strings(SURROGATE_ALPHABET, 6)) {
      const replaced = replaceLoneSurrogates(value);
      expect(replaced).toBe(roundTrip(value));
      expect(hasLoneSurrogate(replaced)).toBe(false);
    }
  });

  it('returns well-formed text unchanged', () => {
    const text = 'BEGIN:VCARD \u0080 ࠀ 😀 \u{10ffff}';
    expect(replaceLoneSurrogates(text)).toBe(text);
  });
});
