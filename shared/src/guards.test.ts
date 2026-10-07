import { describe, expect, it } from 'vitest';
import { isFiniteNumber, isOptional, isRecord, isString } from './guards.js';

describe('shared guards (v1.38.0)', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], 'x', 1, true]) expect(isRecord(value)).toBe(false);
  });

  it('isString, isFiniteNumber and isOptional', () => {
    expect(isString('')).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isFiniteNumber(0)).toBe(true);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      expect(isFiniteNumber(value)).toBe(false);
    }
    expect(isOptional(undefined, isString)).toBe(true);
    expect(isOptional(null, isString)).toBe(true);
    expect(isOptional('x', isString)).toBe(true);
    expect(isOptional(1, isString)).toBe(false);
  });
});
