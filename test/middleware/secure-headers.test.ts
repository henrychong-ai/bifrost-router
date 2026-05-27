import { describe, it, expect } from 'vitest';
import { makeRequest } from '../helpers';

describe('secure headers middleware', () => {
  describe('strict-transport-security', () => {
    it('sets HSTS header at the preload-eligible 1-year max-age', async () => {
      const response = await makeRequest('/health');

      const hsts = response.headers.get('strict-transport-security');
      expect(hsts).toBe('max-age=31536000');
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

    it('sets x-frame-options DENY (hardened from SAMEORIGIN in v1.24.0)', async () => {
      const response = await makeRequest('/health');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    });

    it('sets referrer-policy', async () => {
      const response = await makeRequest('/health');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  describe('Permissions-Policy (v1.24.0+)', () => {
    it('sets Permissions-Policy denying camera / microphone / geolocation / etc', async () => {
      const response = await makeRequest('/health');
      const pp = response.headers.get('permissions-policy');
      expect(pp).not.toBeNull();
      expect(pp).toContain('camera=()');
      expect(pp).toContain('microphone=()');
      expect(pp).toContain('geolocation=()');
      expect(pp).toContain('payment=()');
      expect(pp).toContain('interest-cohort=()');
      expect(pp).toContain('attribution-reporting=()');
      expect(pp).not.toContain('=none');
    });

    it('attaches Permissions-Policy to JSON API responses too (defense-in-depth)', async () => {
      const response = await makeRequest('/health');
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('permissions-policy')).not.toBeNull();
    });
  });
});
