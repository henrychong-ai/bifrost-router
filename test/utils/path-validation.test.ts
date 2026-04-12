import { describe, it, expect } from 'vitest';
import {
  validateR2Key,
  isValidR2Key,
  hasDangerousPath,
  sanitizeR2Key,
} from '../../src/utils/path-validation';

describe('path-validation', () => {
  describe('validateR2Key', () => {
    it('accepts valid keys', () => {
      expect(validateR2Key('documents/report.pdf')).toEqual({
        valid: true,
        sanitizedKey: 'documents/report.pdf',
      });
      expect(validateR2Key('image.png')).toEqual({ valid: true, sanitizedKey: 'image.png' });
      expect(validateR2Key('a/b/c/d.txt')).toEqual({ valid: true, sanitizedKey: 'a/b/c/d.txt' });
    });

    it('rejects empty keys', () => {
      expect(validateR2Key('')).toMatchObject({ valid: false });
      expect(validateR2Key('   ')).toMatchObject({ valid: false });
    });

    it('rejects path traversal (..)', () => {
      expect(validateR2Key('../etc/passwd')).toMatchObject({ valid: false });
      expect(validateR2Key('foo/../../bar')).toMatchObject({ valid: false });
    });

    it('rejects null bytes', () => {
      expect(validateR2Key('foo\x00bar')).toMatchObject({ valid: false });
    });

    it('rejects leading slashes', () => {
      expect(validateR2Key('/foo/bar')).toMatchObject({ valid: false });
      expect(validateR2Key('///foo')).toMatchObject({ valid: false });
    });

    it('rejects hidden components', () => {
      expect(validateR2Key('.git/config')).toMatchObject({ valid: false });
      expect(validateR2Key('foo/.env')).toMatchObject({ valid: false });
      expect(validateR2Key('.hidden')).toMatchObject({ valid: false });
    });

    it('rejects Windows illegal characters', () => {
      expect(validateR2Key('foo<bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo>bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo:bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo"bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo|bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo?bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo*bar')).toMatchObject({ valid: false });
    });

    it('rejects control characters', () => {
      expect(validateR2Key('foo\x01bar')).toMatchObject({ valid: false });
      expect(validateR2Key('foo\x1fbar')).toMatchObject({ valid: false });
    });
  });

  describe('isValidR2Key', () => {
    it('returns true for valid keys', () => {
      expect(isValidR2Key('valid/key.txt')).toBe(true);
    });
    it('returns false for invalid keys', () => {
      expect(isValidR2Key('../bad')).toBe(false);
    });
  });

  describe('hasDangerousPath', () => {
    it('detects dangerous patterns', () => {
      expect(hasDangerousPath('..')).toBe(true);
      expect(hasDangerousPath('.git/config')).toBe(true);
    });
    it('passes clean paths', () => {
      expect(hasDangerousPath('clean/path.txt')).toBe(false);
    });
  });

  describe('sanitizeR2Key', () => {
    it('removes dangerous patterns', () => {
      expect(sanitizeR2Key('../foo')).toBe('foo');
      expect(sanitizeR2Key('/leading/slash')).toBe('leading/slash');
    });
  });
});
