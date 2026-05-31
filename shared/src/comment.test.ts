import { describe, it, expect } from 'vitest';
import {
  COMMENT_MAX_LENGTH,
  sanitizeComment,
  isCommentEmpty,
  CommentSchema,
  CommentFieldSchema,
} from './comment.js';

describe('sanitizeComment', () => {
  it('returns null for nullish input', () => {
    expect(sanitizeComment(null)).toBeNull();
    expect(sanitizeComment(undefined)).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(sanitizeComment('')).toBeNull();
    expect(sanitizeComment('   ')).toBeNull();
    expect(sanitizeComment('\n\t  \n')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeComment('  hello  ')).toBe('hello');
  });

  it('preserves interior newlines and tabs (multi-line allowed)', () => {
    expect(sanitizeComment('line one\nline two')).toBe('line one\nline two');
    expect(sanitizeComment('a\tb')).toBe('a\tb');
  });

  it('normalises CRLF and lone CR to LF', () => {
    expect(sanitizeComment('a\r\nb')).toBe('a\nb');
    expect(sanitizeComment('a\rb')).toBe('a\nb');
  });

  it('strips other control characters but keeps the surrounding text', () => {
    // a NUL b BEL c ESC d DEL e — all C0/DEL controls should be removed
    const withControls = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c${String.fromCharCode(
      27,
    )}d${String.fromCharCode(127)}e`;
    expect(sanitizeComment(withControls)).toBe('abcde');
  });

  it('preserves unicode / emoji content', () => {
    expect(sanitizeComment('café ☕ 你好 🎉')).toBe('café ☕ 你好 🎉');
  });

  it('clamps to COMMENT_MAX_LENGTH as a backstop', () => {
    const long = 'x'.repeat(COMMENT_MAX_LENGTH + 50);
    expect(sanitizeComment(long)?.length).toBe(COMMENT_MAX_LENGTH);
  });

  it('does not clamp content exactly at the limit', () => {
    const exact = 'y'.repeat(COMMENT_MAX_LENGTH);
    expect(sanitizeComment(exact)?.length).toBe(COMMENT_MAX_LENGTH);
  });
});

describe('isCommentEmpty', () => {
  it('is true for nullish / blank input', () => {
    expect(isCommentEmpty(null)).toBe(true);
    expect(isCommentEmpty(undefined)).toBe(true);
    expect(isCommentEmpty('   ')).toBe(true);
    expect(isCommentEmpty(' ')).toBe(true);
  });

  it('is false for real content', () => {
    expect(isCommentEmpty('note')).toBe(false);
  });
});

describe('CommentSchema', () => {
  it('accepts strings up to the limit', () => {
    expect(CommentSchema.safeParse('a'.repeat(COMMENT_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects strings over the limit', () => {
    expect(CommentSchema.safeParse('a'.repeat(COMMENT_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('CommentFieldSchema', () => {
  it('accepts a string, null, and undefined (omitted = untouched)', () => {
    expect(CommentFieldSchema.safeParse('hi').success).toBe(true);
    expect(CommentFieldSchema.safeParse(null).success).toBe(true);
    expect(CommentFieldSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects an over-length string', () => {
    expect(CommentFieldSchema.safeParse('a'.repeat(COMMENT_MAX_LENGTH + 1)).success).toBe(false);
  });
});
