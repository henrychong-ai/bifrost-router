import { describe, it, expect } from 'vitest';
import {
  hasDangerousPath,
  sanitizeR2Key,
  validateR2Key,
  isValidR2Key,
} from '../../src/utils/path-validation';

describe('hasDangerousPath', () => {
  it('detects parent directory traversal', () => {
    expect(hasDangerousPath('../etc/passwd')).toBe(true);
    expect(hasDangerousPath('foo/../bar')).toBe(true);
    expect(hasDangerousPath('foo/bar/..')).toBe(true);
  });

  it('detects null bytes', () => {
    expect(hasDangerousPath('file.txt\x00.jpg')).toBe(true);
    expect(hasDangerousPath('\x00malicious')).toBe(true);
  });

  it('detects leading slashes', () => {
    expect(hasDangerousPath('/etc/passwd')).toBe(true);
    expect(hasDangerousPath('//etc/passwd')).toBe(true);
  });

  it('detects hidden directories', () => {
    expect(hasDangerousPath('foo/.hidden/bar')).toBe(true);
    expect(hasDangerousPath('/.git/config')).toBe(true);
  });

  it('allows valid paths', () => {
    expect(hasDangerousPath('media-kit/file.zip')).toBe(false);
    expect(hasDangerousPath('images/photo.jpg')).toBe(false);
    expect(hasDangerousPath('document.pdf')).toBe(false);
  });
});

describe('sanitizeR2Key', () => {
  it('removes parent directory traversal', () => {
    expect(sanitizeR2Key('../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeR2Key('foo/../bar')).toBe('foo/bar');
    expect(sanitizeR2Key('foo/../../bar')).toBe('foo/bar');
    expect(sanitizeR2Key('....//test')).toBe('test');
  });

  it('removes null bytes', () => {
    expect(sanitizeR2Key('file.txt\x00.jpg')).toBe('file.txt.jpg');
    expect(sanitizeR2Key('\x00malicious')).toBe('malicious');
  });

  it('removes leading slashes', () => {
    expect(sanitizeR2Key('/etc/passwd')).toBe('etc/passwd');
    expect(sanitizeR2Key('///foo/bar')).toBe('foo/bar');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(sanitizeR2Key('foo\\bar\\baz')).toBe('foo/bar/baz');
  });

  it('removes multiple consecutive slashes', () => {
    expect(sanitizeR2Key('foo//bar///baz')).toBe('foo/bar/baz');
  });

  it('removes trailing slashes', () => {
    expect(sanitizeR2Key('foo/bar/')).toBe('foo/bar');
    expect(sanitizeR2Key('foo/bar///')).toBe('foo/bar');
  });

  it('preserves valid paths', () => {
    expect(sanitizeR2Key('media-kit/file.zip')).toBe('media-kit/file.zip');
    expect(sanitizeR2Key('images/photo.jpg')).toBe('images/photo.jpg');
  });
});

describe('validateR2Key', () => {
  describe('valid keys', () => {
    it('accepts simple file names', () => {
      const result = validateR2Key('document.pdf');
      expect(result.valid).toBe(true);
      expect(result.sanitizedKey).toBe('document.pdf');
    });

    it('accepts paths with directories', () => {
      const result = validateR2Key('media-kit/henrychong.zip');
      expect(result.valid).toBe(true);
      expect(result.sanitizedKey).toBe('media-kit/henrychong.zip');
    });

    it('accepts deeply nested paths', () => {
      const result = validateR2Key('a/b/c/d/e/file.txt');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid keys', () => {
    it('rejects empty string', () => {
      const result = validateR2Key('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('rejects whitespace-only string', () => {
      const result = validateR2Key('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('rejects keys that sanitize to empty', () => {
      const result = validateR2Key('///');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });
  });

  describe('sanitization', () => {
    it('sanitizes path traversal attempts', () => {
      const result = validateR2Key('../etc/passwd');
      expect(result.valid).toBe(true);
      expect(result.sanitizedKey).toBe('etc/passwd');
    });

    it('sanitizes leading slashes', () => {
      const result = validateR2Key('/media-kit/file.zip');
      expect(result.valid).toBe(true);
      expect(result.sanitizedKey).toBe('media-kit/file.zip');
    });
  });
});

describe('isValidR2Key', () => {
  it('returns true for valid keys', () => {
    expect(isValidR2Key('media-kit/file.zip')).toBe(true);
    expect(isValidR2Key('document.pdf')).toBe(true);
  });

  it('returns false for invalid keys', () => {
    expect(isValidR2Key('')).toBe(false);
    expect(isValidR2Key('///')).toBe(false);
  });
});
