import { describe, expect, it } from 'vitest';
import {
  isPrivateIP,
  isValidProxyTarget,
  PROXY_TARGET_ERRORS,
  validateProxyTarget,
} from '../../src/utils/url-validation';

describe('isPrivateIP', () => {
  describe('IPv4 private ranges', () => {
    it('blocks 10.x.x.x range', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('10.255.255.255')).toBe(true);
    });

    it('blocks 172.16-31.x.x range', () => {
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('172.31.255.255')).toBe(true);
      expect(isPrivateIP('172.15.0.1')).toBe(false); // Just outside range
      expect(isPrivateIP('172.32.0.1')).toBe(false); // Just outside range
    });

    it('blocks 192.168.x.x range', () => {
      expect(isPrivateIP('192.168.0.1')).toBe(true);
      expect(isPrivateIP('192.168.255.255')).toBe(true);
    });

    it('blocks loopback (127.x.x.x)', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('127.255.255.255')).toBe(true);
    });

    it('blocks link-local (169.254.x.x)', () => {
      expect(isPrivateIP('169.254.0.1')).toBe(true);
      expect(isPrivateIP('169.254.169.254')).toBe(true); // AWS metadata
    });
  });

  describe('blocked hostnames', () => {
    it('blocks localhost variants', () => {
      expect(isPrivateIP('localhost')).toBe(true);
      expect(isPrivateIP('LOCALHOST')).toBe(true);
      expect(isPrivateIP('localhost.localdomain')).toBe(true);
    });

    it('blocks cloud metadata endpoints', () => {
      expect(isPrivateIP('169.254.169.254')).toBe(true);
      expect(isPrivateIP('metadata.google.internal')).toBe(true);
    });
  });

  describe('valid public IPs', () => {
    it('allows public IPs', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
    });

    it('allows public hostnames', () => {
      expect(isPrivateIP('example.com')).toBe(false);
      expect(isPrivateIP('api.github.com')).toBe(false);
    });
  });
});

describe('validateProxyTarget', () => {
  describe('valid targets', () => {
    it('accepts valid HTTPS URLs', () => {
      const result = validateProxyTarget('https://example.com');
      expect(result.valid).toBe(true);
      expect(result.url?.hostname).toBe('example.com');
    });

    it('accepts valid HTTP URLs', () => {
      const result = validateProxyTarget('http://api.example.com:8080/path');
      expect(result.valid).toBe(true);
      expect(result.url?.hostname).toBe('api.example.com');
    });

    it('accepts URLs with paths and query strings', () => {
      const result = validateProxyTarget('https://example.com/api/v1?key=value');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid format', () => {
    it('rejects invalid URL format', () => {
      const result = validateProxyTarget('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL format');
    });

    // v1.38.0: a stored target can carry a credential, and the proxy logs
    // the refusal on every visitor request, so no message quotes the target
    it.each([
      ['not-an-absolute-url?token=SECRET', PROXY_TARGET_ERRORS.format],
      ['ftp://user:SECRET@files.example.net/?token=SECRET', PROXY_TARGET_ERRORS.protocol],
      ['http://10.0.0.1/?token=SECRET', PROXY_TARGET_ERRORS.address],
      ['http://secret.local/?token=SECRET', PROXY_TARGET_ERRORS.address],
    ])('refuses %s with fixed text that quotes none of it', (target, error) => {
      const result = validateProxyTarget(target);
      expect(result).toEqual({ valid: false, error });
      expect(result.error?.toLowerCase()).not.toContain('secret');
    });

    it('rejects empty string', () => {
      const result = validateProxyTarget('');
      expect(result.valid).toBe(false);
    });
  });

  // v1.38.0: a hostname that is not letters, digits, hyphens and dots can
  // never be fetched, and the runtime's error for it names the whole URL
  describe('hostname shape', () => {
    it.each([
      'https://*.example.com/x?token=SECRET',
      'https://under_score.example.com/',
      'https://a..example.com/',
      'https://ex$ample.com/',
    ])('refuses %s with fixed text', target => {
      const result = validateProxyTarget(target);
      expect(result).toEqual({ valid: false, error: PROXY_TARGET_ERRORS.hostname });
    });

    it.each([
      'https://example.com/',
      'https://example.com./',
      'https://api-2.example.net:8443/v1',
      'https://bücher.example/',
      'https://xn--bcher-kva.example/',
      'http://[2606:4700:4700::1111]/',
      'http://1.1.1.1/',
    ])('accepts %s', target => {
      expect(validateProxyTarget(target).valid).toBe(true);
    });

    it('keeps the address rules for IP literals', () => {
      expect(validateProxyTarget('http://127.1/').error).toBe(PROXY_TARGET_ERRORS.address);
      expect(validateProxyTarget('http://[::1]/').error).toBe(PROXY_TARGET_ERRORS.address);
    });
  });

  describe('blocked protocols', () => {
    it('rejects file: protocol', () => {
      const result = validateProxyTarget('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid protocol');
    });

    it('rejects javascript: protocol', () => {
      const result = validateProxyTarget('javascript:alert(1)');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid protocol');
    });

    it('rejects ftp: protocol', () => {
      const result = validateProxyTarget('ftp://ftp.example.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid protocol');
    });
  });

  describe('SSRF protection', () => {
    it('rejects localhost', () => {
      const result = validateProxyTarget('http://localhost:8080');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(PROXY_TARGET_ERRORS.address);
    });

    it('rejects 127.0.0.1', () => {
      const result = validateProxyTarget('http://127.0.0.1');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(PROXY_TARGET_ERRORS.address);
    });

    it('rejects private IP ranges', () => {
      expect(validateProxyTarget('http://192.168.1.1').valid).toBe(false);
      expect(validateProxyTarget('http://10.0.0.1').valid).toBe(false);
      expect(validateProxyTarget('http://172.16.0.1').valid).toBe(false);
    });

    it('rejects AWS metadata endpoint', () => {
      const result = validateProxyTarget('http://169.254.169.254/latest/meta-data');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(PROXY_TARGET_ERRORS.address);
    });

    it('rejects GCP metadata endpoint', () => {
      const result = validateProxyTarget('http://metadata.google.internal');
      expect(result.valid).toBe(false);
    });
  });
});

describe('isValidProxyTarget', () => {
  it('returns true for valid targets', () => {
    expect(isValidProxyTarget('https://example.com')).toBe(true);
    expect(isValidProxyTarget('http://api.github.com')).toBe(true);
  });

  it('returns false for invalid targets', () => {
    expect(isValidProxyTarget('not-a-url')).toBe(false);
    expect(isValidProxyTarget('http://localhost')).toBe(false);
    expect(isValidProxyTarget('file:///etc/passwd')).toBe(false);
  });
});
