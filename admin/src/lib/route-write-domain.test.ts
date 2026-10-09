import { describe, expect, it } from 'vitest';
import { RouteWriteRefusedError } from './api-error';
import { RouteWriteDomainError, requireWriteDomain, writeDomain } from './route-write-domain';

// v1.41.2: one resolution for the Routes page's checks and its writes
describe('writeDomain', () => {
  it('resolves as requireWriteDomain does, an empty string being no domain', () => {
    expect(writeDomain('secondary.example.net', 'example.com')).toBe('secondary.example.net');
    expect(writeDomain(undefined, 'example.com')).toBe('example.com');
    expect(writeDomain('', 'example.com')).toBe('example.com');
    expect(writeDomain('', '')).toBeUndefined();
    expect(writeDomain(undefined, undefined)).toBeUndefined();
  });
});

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

  // v1.41.2: refused before any request, so it reads as definite
  it('throws a RouteWriteDomainError, a RouteWriteRefusedError', () => {
    expect(() => requireWriteDomain(undefined, undefined)).toThrow(RouteWriteDomainError);
    expect(new RouteWriteDomainError()).toBeInstanceOf(RouteWriteRefusedError);
  });
});
