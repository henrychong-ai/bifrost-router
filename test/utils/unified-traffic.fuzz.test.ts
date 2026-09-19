import { describe, expect, it } from 'vitest';
import {
  findCredentialParams,
  redactSensitiveQueryValues,
  redactRouteTarget,
} from '../../src/utils/credential-redaction';

/** Independent planted-secret oracle: fixed seeds, no production predicates. */
describe('credential containment properties', () => {
  const names = ['token', 'password', 'api_key', 'code', 'state', 'ticket', 'client_secret'];
  const wrap = [
    (n: string, s: string) => `${n}=${s}`,
    (n: string, s: string) => `next=${encodeURIComponent(`https://example.com/?${n}=${s}`)}`,
    (n: string, s: string) => `next=${encodeURIComponent(`/auth/${n}=${s}/tail`)}`,
    (n: string, s: string) => `next=${encodeURIComponent(`#${n}=${s}`)}`,
    (n: string, s: string) => `next=x;${n}=${s}`,
    (n: string, s: string) => `next=${encodeURIComponent(encodeURIComponent(`${n}=${s}`))}`,
    (n: string, s: string) => `next=${n}?v=${s}`,
  ];

  it.each([17, 729, 65537])('contains generated secrets (seed %s)', (seed) => {
    let state = seed;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 1000; i++) {
      const name = names[next() % names.length];
      const secret = `PLANTED_${next().toString(16)}_VALUE`;
      const query = `?${wrap[next() % wrap.length](name, secret)}&utm_source=mail`;
      const result = redactSensitiveQueryValues(query)!;
      expect(result).not.toContain(secret);
      expect(result).toContain('&utm_source=mail');
      expect(redactSensitiveQueryValues(result)).toBe(result);
      expect(findCredentialParams(query).length).toBeGreaterThan(0);
      const stored = redactRouteTarget(`https://example.com/${query}`);
      expect(stored).not.toContain(secret);
      expect(redactRouteTarget(stored)).toBe(stored);
    }
  });

  it('keeps ordinary generated campaign fields byte-identical', () => {
    for (let i = 0; i < 1000; i++) {
      const query = `?promo=Summer${i}Sale&utm_source=email+${i}&page=${i}&flag`;
      expect(redactSensitiveQueryValues(query)).toBe(query);
      expect(findCredentialParams(query)).toEqual([]);
    }
  });

  it('masks pathological input without recursive parsing or uncaught Unicode errors', () => {
    for (const value of ['/?'.repeat(10000), 'x=1?'.repeat(10000), '\ud800', '%ED%A0%80']) {
      const query = `?token=${value}`;
      expect(() => redactSensitiveQueryValues(query)).not.toThrow();
      expect(redactSensitiveQueryValues(query)).not.toContain(value);
    }
  });
});
