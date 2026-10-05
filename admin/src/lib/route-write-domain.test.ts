import { describe, expect, it } from 'vitest';
import { requireWriteDomain } from './route-write-domain';

describe('requireWriteDomain', () => {
  it("prefers the route's own domain over the selected one", () => {
    expect(requireWriteDomain('secondary.example.net', 'example.com')).toBe(
      'secondary.example.net',
    );
  });

  it('falls back to the selected domain', () => {
    expect(requireWriteDomain(undefined, 'example.com')).toBe('example.com');
    expect(requireWriteDomain('', 'user1.example.com')).toBe('user1.example.com');
  });

  it('throws instead of sending a write with no domain', () => {
    expect(() => requireWriteDomain(undefined, undefined)).toThrow(
      'This route has no domain. Select its domain and try again.',
    );
    expect(() => requireWriteDomain('', '')).toThrow('This route has no domain');
  });
});
