import { describe, it, expect } from 'vitest';
import { makeRequest } from '../helpers';

describe('secure headers middleware', () => {
  describe('strict-transport-security', () => {
    it('sets HSTS header without includeSubDomains', async () => {
      const response = await makeRequest('/health');

      const hsts = response.headers.get('strict-transport-security');
      expect(hsts).toBe('max-age=15552000');
    });

    it('does not include includeSubDomains directive', async () => {
      const response = await makeRequest('/health');

      const hsts = response.headers.get('strict-transport-security');
      expect(hsts).not.toContain('includeSubDomains');
    });
  });

  describe('other security headers', () => {
    it('sets x-content-type-options', async () => {
      const response = await makeRequest('/health');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('sets x-frame-options', async () => {
      const response = await makeRequest('/health');
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('sets referrer-policy', async () => {
      const response = await makeRequest('/health');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });
});
