import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';
import { isRedirectStatusCode } from './types.js';

describe('canonicalJson', () => {
  it('writes the same text whatever the key order, at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 3, e: 4 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"e":4,"f":3}]},"b":1}',
    );
  });

  it('leaves out a key JSON cannot hold, and writes such an array item as null', () => {
    expect(canonicalJson({ a: undefined, b: () => 1, c: 'x' })).toBe('{"c":"x"}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('matches JSON.stringify for values without objects', () => {
    for (const value of ['text', 7, true, null, ['a', 1]]) {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
  });
});

describe('isRedirectStatusCode', () => {
  it('accepts the four codes a route write accepts, and nothing else', () => {
    expect([301, 302, 307, 308].every(isRedirectStatusCode)).toBe(true);
    for (const value of [200, 303, '301', null, undefined, 301.5]) {
      expect(isRedirectStatusCode(value)).toBe(false);
    }
  });
});
