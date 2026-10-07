import { describe, expect, it } from 'vitest';
import { isSupportedDomain, SUPPORTED_DOMAINS } from './types.js';

describe('types', () => {
  describe('SUPPORTED_DOMAINS', () => {
    it('contains expected domains', () => {
      expect(SUPPORTED_DOMAINS).toContain('links.example.com');
      expect(SUPPORTED_DOMAINS).toContain('example.com');
      expect(SUPPORTED_DOMAINS).toContain('secondary.example.net');
      expect(SUPPORTED_DOMAINS.length).toBe(9);
    });
  });

  describe('isSupportedDomain', () => {
    it('returns true for supported domains', () => {
      expect(isSupportedDomain('links.example.com')).toBe(true);
      expect(isSupportedDomain('example.com')).toBe(true);
      expect(isSupportedDomain('secondary.example.net')).toBe(true);
    });

    it('returns false for unsupported domains', () => {
      expect(isSupportedDomain('unsupported.example.org')).toBe(false);
      expect(isSupportedDomain('localhost')).toBe(false);
      expect(isSupportedDomain('')).toBe(false);
    });
  });
});
