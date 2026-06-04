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

  describe('validateR2Key with { normalize } (v1.27.0)', () => {
    it('passes a spaced/mixed-case key through UNCHANGED when normalize is off (today)', () => {
      const r = validateR2Key('My Report.PDF');
      expect(r.valid).toBe(true);
      expect(r.sanitizedKey).toBe('My Report.PDF');
    });

    it('leaves a clean key unchanged whether normalize is on or off', () => {
      expect(validateR2Key('images/logo.png').sanitizedKey).toBe('images/logo.png');
      expect(validateR2Key('images/logo.png', { normalize: true }).sanitizedKey).toBe(
        'images/logo.png',
      );
    });

    it('normalizes to lowercase-kebab when normalize is on', () => {
      const r = validateR2Key('Photos/My Report.PDF', { normalize: true });
      expect(r.valid).toBe(true);
      expect(r.sanitizedKey).toBe('photos/my-report.pdf');
    });

    it('does NOT normalize when normalize is off — case/spaces pass through', () => {
      const r = validateR2Key('Photos/My-Report.PDF', { normalize: false });
      expect(r.valid).toBe(true);
      expect(r.sanitizedKey).toBe('Photos/My-Report.PDF');
    });

    it('still REJECTS dangerous patterns BEFORE normalizing (security pre-gate)', () => {
      // Traversal / hidden / windows-illegal are rejected even with normalize:true.
      expect(validateR2Key('../etc/passwd', { normalize: true }).valid).toBe(false);
      expect(validateR2Key('.env', { normalize: true }).valid).toBe(false);
      expect(validateR2Key('file<x>.txt', { normalize: true }).valid).toBe(false);
    });

    it('rejects a key that normalizes to empty', () => {
      // '---' passes the dangerous-pattern gate (no traversal/illegal chars) but
      // normalizes to '' (all-separator) → rejected at the normalize step.
      const r = validateR2Key('---', { normalize: true });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('normalization');
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
