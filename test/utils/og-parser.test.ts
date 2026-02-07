import { describe, it, expect } from 'vitest';
import {
  validateUrlForSSRF,
  SSRFBlockedError,
} from '../../src/utils/og-parser';

describe('validateUrlForSSRF', () => {
  describe('valid public URLs', () => {
    it('accepts valid HTTPS URLs', () => {
      const url = validateUrlForSSRF('https://example.com');
      expect(url.hostname).toBe('example.com');
    });

    it('accepts valid HTTP URLs', () => {
      const url = validateUrlForSSRF('http://example.com');
      expect(url.hostname).toBe('example.com');
    });

    it('accepts URLs with paths and query strings', () => {
      const url = validateUrlForSSRF('https://example.com/page?query=value');
      expect(url.pathname).toBe('/page');
      expect(url.search).toBe('?query=value');
    });

    it('accepts public IP addresses', () => {
      const url = validateUrlForSSRF('https://93.184.216.34');
      expect(url.hostname).toBe('93.184.216.34');
    });
  });

  describe('blocked schemes', () => {
    it('rejects file: protocol', () => {
      expect(() => validateUrlForSSRF('file:///etc/passwd')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects javascript: protocol', () => {
      expect(() => validateUrlForSSRF('javascript:alert(1)')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects ftp: protocol', () => {
      expect(() => validateUrlForSSRF('ftp://ftp.example.com')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects data: protocol', () => {
      expect(() => validateUrlForSSRF('data:text/html,<h1>test</h1>')).toThrow(
        SSRFBlockedError
      );
    });
  });

  describe('blocked hostnames', () => {
    it('rejects localhost', () => {
      expect(() => validateUrlForSSRF('http://localhost')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects localhost.localdomain', () => {
      expect(() => validateUrlForSSRF('http://localhost.localdomain')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects 0.0.0.0', () => {
      expect(() => validateUrlForSSRF('http://0.0.0.0')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects kubernetes service names', () => {
      expect(() => validateUrlForSSRF('http://kubernetes')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://kubernetes.default')).toThrow(
        SSRFBlockedError
      );
    });

    it('rejects metadata hostnames', () => {
      expect(() => validateUrlForSSRF('http://metadata')).toThrow(
        SSRFBlockedError
      );
      expect(() =>
        validateUrlForSSRF('http://metadata.google.internal')
      ).toThrow(SSRFBlockedError);
    });
  });

  describe('IPv4 private ranges', () => {
    it('blocks loopback (127.x.x.x)', () => {
      expect(() => validateUrlForSSRF('http://127.0.0.1')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://127.255.255.255')).toThrow(
        SSRFBlockedError
      );
    });

    it('blocks 10.x.x.x range', () => {
      expect(() => validateUrlForSSRF('http://10.0.0.1')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://10.255.255.255')).toThrow(
        SSRFBlockedError
      );
    });

    it('blocks 172.16-31.x.x range', () => {
      expect(() => validateUrlForSSRF('http://172.16.0.1')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://172.31.255.255')).toThrow(
        SSRFBlockedError
      );
    });

    it('allows IPs just outside 172.16-31.x.x range', () => {
      // 172.15.x.x and 172.32.x.x are public
      expect(() =>
        validateUrlForSSRF('http://172.15.0.1')
      ).not.toThrow();
      expect(() =>
        validateUrlForSSRF('http://172.32.0.1')
      ).not.toThrow();
    });

    it('blocks 192.168.x.x range', () => {
      expect(() => validateUrlForSSRF('http://192.168.0.1')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://192.168.255.255')).toThrow(
        SSRFBlockedError
      );
    });

    it('blocks link-local (169.254.x.x)', () => {
      expect(() => validateUrlForSSRF('http://169.254.0.1')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://169.254.255.255')).toThrow(
        SSRFBlockedError
      );
    });

    it('blocks 0.x.x.x range', () => {
      expect(() => validateUrlForSSRF('http://0.0.0.0')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://0.1.2.3')).toThrow(
        SSRFBlockedError
      );
    });
  });

  describe('cloud metadata endpoints', () => {
    it('blocks AWS/GCP/Azure metadata (169.254.169.254)', () => {
      expect(() =>
        validateUrlForSSRF('http://169.254.169.254/latest/meta-data')
      ).toThrow(SSRFBlockedError);
    });

    it('blocks AWS ECS metadata (169.254.170.2)', () => {
      expect(() => validateUrlForSSRF('http://169.254.170.2')).toThrow(
        SSRFBlockedError
      );
    });

    it('blocks Alibaba Cloud metadata (100.100.100.200)', () => {
      expect(() => validateUrlForSSRF('http://100.100.100.200')).toThrow(
        SSRFBlockedError
      );
    });
  });

  describe('IPv6 addresses', () => {
    it('blocks IPv6 loopback (::1)', () => {
      expect(() => validateUrlForSSRF('http://[::1]')).toThrow(SSRFBlockedError);
    });

    it('blocks IPv6 private (fc00::/7)', () => {
      expect(() => validateUrlForSSRF('http://[fc00::1]')).toThrow(
        SSRFBlockedError
      );
      expect(() => validateUrlForSSRF('http://[fd00::1]')).toThrow(
        SSRFBlockedError
      );
    });

    it('blocks IPv6 link-local (fe80::/10)', () => {
      expect(() => validateUrlForSSRF('http://[fe80::1]')).toThrow(
        SSRFBlockedError
      );
    });
  });

  describe('invalid URLs', () => {
    it('rejects invalid URL format', () => {
      expect(() => validateUrlForSSRF('not-a-url')).toThrow(SSRFBlockedError);
    });

    it('rejects empty string', () => {
      expect(() => validateUrlForSSRF('')).toThrow(SSRFBlockedError);
    });

    it('rejects URLs without scheme', () => {
      expect(() => validateUrlForSSRF('example.com')).toThrow(SSRFBlockedError);
    });
  });
});
