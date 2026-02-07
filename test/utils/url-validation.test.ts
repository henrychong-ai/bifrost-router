import { describe, it, expect } from 'vitest';
import {
  isPrivateIP,
  validateProxyTarget,
  isValidProxyTarget,
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

    it('rejects empty string', () => {
      const result = validateProxyTarget('');
      expect(result.valid).toBe(false);
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
      expect(result.error).toContain('private/internal');
    });

    it('rejects 127.0.0.1', () => {
      const result = validateProxyTarget('http://127.0.0.1');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('private/internal');
    });

    it('rejects private IP ranges', () => {
      expect(validateProxyTarget('http://192.168.1.1').valid).toBe(false);
      expect(validateProxyTarget('http://10.0.0.1').valid).toBe(false);
      expect(validateProxyTarget('http://172.16.0.1').valid).toBe(false);
    });

    it('rejects AWS metadata endpoint', () => {
      const result = validateProxyTarget('http://169.254.169.254/latest/meta-data');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('private/internal');
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
