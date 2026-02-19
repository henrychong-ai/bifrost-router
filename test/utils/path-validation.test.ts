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

  describe('strict reject', () => {
    it('rejects path traversal attempts', () => {
      const result = validateR2Key('../etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('rejects leading slashes', () => {
      const result = validateR2Key('/media-kit/file.zip');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
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

describe('strict reject - extended patterns', () => {
  describe('hidden components', () => {
    it('rejects .git directory', () => {
      expect(hasDangerousPath('.git/config')).toBe(true);
    });

    it('rejects .env file in path', () => {
      expect(hasDangerousPath('foo/.env')).toBe(true);
    });

    it('rejects .hidden subdirectory', () => {
      expect(hasDangerousPath('foo/.hidden/bar')).toBe(true);
    });

    it('validateR2Key rejects hidden components', () => {
      expect(validateR2Key('.git/config').valid).toBe(false);
      expect(validateR2Key('some/.env').valid).toBe(false);
    });
  });

  describe('Windows illegal characters', () => {
    it('rejects angle brackets', () => {
      expect(hasDangerousPath('file<name>.txt')).toBe(true);
    });

    it('rejects colon', () => {
      expect(hasDangerousPath('C:file.txt')).toBe(true);
    });

    it('rejects double quote', () => {
      expect(hasDangerousPath('file"name.txt')).toBe(true);
    });

    it('rejects pipe character', () => {
      expect(hasDangerousPath('file|name.txt')).toBe(true);
    });

    it('rejects question mark', () => {
      expect(hasDangerousPath('file?.txt')).toBe(true);
    });

    it('rejects asterisk', () => {
      expect(hasDangerousPath('file*.txt')).toBe(true);
    });

    it('validateR2Key rejects Windows illegal chars', () => {
      expect(validateR2Key('file<name>.txt').valid).toBe(false);
      expect(validateR2Key('file|name.txt').valid).toBe(false);
      expect(validateR2Key('file?.txt').valid).toBe(false);
    });
  });

  describe('control characters', () => {
    it('rejects tab character', () => {
      expect(hasDangerousPath('file\tname.txt')).toBe(true);
    });

    it('rejects newline character', () => {
      expect(hasDangerousPath('file\nname.txt')).toBe(true);
    });

    it('rejects carriage return', () => {
      expect(hasDangerousPath('file\rname.txt')).toBe(true);
    });

    it('rejects bell character', () => {
      expect(hasDangerousPath('file\x07name.txt')).toBe(true);
    });

    it('validateR2Key rejects control characters', () => {
      expect(validateR2Key('file\tname.txt').valid).toBe(false);
      expect(validateR2Key('file\nname.txt').valid).toBe(false);
    });
  });

  describe('backslashes', () => {
    it('sanitizeR2Key normalizes backslashes to forward slashes', () => {
      expect(sanitizeR2Key('foo\\bar\\baz')).toBe('foo/bar/baz');
    });

    it('validateR2Key rejects backslashes (key !== sanitized)', () => {
      const result = validateR2Key('foo\\bar');
      expect(result.valid).toBe(false);
    });
  });

  describe('empty path components', () => {
    it('sanitizeR2Key collapses double slashes', () => {
      expect(sanitizeR2Key('foo//bar')).toBe('foo/bar');
    });

    it('sanitizeR2Key collapses triple slashes', () => {
      expect(sanitizeR2Key('foo///bar')).toBe('foo/bar');
    });

    it('validateR2Key rejects double slashes', () => {
      const result = validateR2Key('foo//bar');
      expect(result.valid).toBe(false);
    });
  });

  describe('double dots in various positions', () => {
    it('rejects leading double dots', () => {
      expect(hasDangerousPath('../secret')).toBe(true);
    });

    it('rejects middle double dots', () => {
      expect(hasDangerousPath('foo/../bar')).toBe(true);
    });

    it('rejects trailing double dots', () => {
      expect(hasDangerousPath('foo/bar/..')).toBe(true);
    });

    it('rejects multiple double dot sequences', () => {
      expect(hasDangerousPath('foo/../../bar')).toBe(true);
    });

    it('validateR2Key rejects all double dot patterns', () => {
      expect(validateR2Key('../secret').valid).toBe(false);
      expect(validateR2Key('foo/../bar').valid).toBe(false);
      expect(validateR2Key('foo/bar/..').valid).toBe(false);
    });
  });
});
