import { describe, expect, it } from 'vitest';
import { allStrings, growthRatio, LINEAR_GROWTH_LIMIT } from './linear.test-support.js';
import { trimEndChars, trimStartChars } from './trim-chars.js';

// v1.39.0: linear replacements for the trailing-run regexes code scanning
// flags as polynomial
describe('trimEndChars and trimStartChars', () => {
  it('equal the regexes they replace on every short string', () => {
    for (const value of allStrings(['-', '.', 'a', '/', '\n'], 6)) {
      expect(trimEndChars(value, '-.')).toBe(value.replace(/[-.]+$/, ''));
      expect(trimEndChars(value, '-')).toBe(value.replace(/-+$/, ''));
      expect(trimEndChars(value, '/')).toBe(value.replace(/\/+$/, ''));
      expect(trimStartChars(value, '-.')).toBe(value.replace(/^[-.]+/, ''));
    }
  });

  it('are linear on a long run that does not end (or start) the string', () => {
    for (const [fn, input] of [
      [(value: string) => trimEndChars(value, '-.'), (n: number) => `${'-.'.repeat(n / 2)}a`],
      [(value: string) => trimEndChars(value, '-'), (n: number) => `a${'-'.repeat(n)}`],
      [(value: string) => trimStartChars(value, '-.'), (n: number) => `a${'.-'.repeat(n / 2)}`],
    ] as const) {
      expect(growthRatio(fn, input)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }
  });

  it('control: the growth check flags a quadratic regex', () => {
    // About 64 for a quadratic scan; small sizes keep the control quick
    const ratio = growthRatio(
      value => value.replace(/[-.]+$/, ''),
      n => `${'-'.repeat(n)}a`,
      1000,
    );
    expect(ratio).toBeGreaterThan(LINEAR_GROWTH_LIMIT);
  });
});
