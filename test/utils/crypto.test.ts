import { describe, it, expect } from 'vitest';
import { timingSafeEqual, validateApiKey } from '../../src/utils/crypto';

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true);
    expect(timingSafeEqual('test-api-key-12345', 'test-api-key-12345')).toBe(
      true,
    );
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeEqual('hello', 'world')).toBe(false);
    expect(timingSafeEqual('test', 'testing')).toBe(false);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
    expect(timingSafeEqual('a', 'ab')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });

  it('handles unicode strings', () => {
    expect(timingSafeEqual('hello\u0000world', 'hello\u0000world')).toBe(true);
    expect(timingSafeEqual('hello\u0000', 'hello')).toBe(false);
  });

  it('handles special characters', () => {
    const key1 = 'abc!@#$%^&*()123';
    const key2 = 'abc!@#$%^&*()123';
    expect(timingSafeEqual(key1, key2)).toBe(true);
  });
});

describe('validateApiKey', () => {
  const validKey = 'test-api-key-12345';

  it('returns true for matching API keys', () => {
    expect(validateApiKey(validKey, validKey)).toBe(true);
  });

  it('returns false for mismatched API keys', () => {
    expect(validateApiKey('wrong-key', validKey)).toBe(false);
    expect(validateApiKey(validKey, 'wrong-key')).toBe(false);
  });

  it('returns false for null/undefined provided key', () => {
    expect(validateApiKey(null, validKey)).toBe(false);
    expect(validateApiKey(undefined, validKey)).toBe(false);
    expect(validateApiKey('', validKey)).toBe(false);
  });

  it('returns false for null/undefined expected key', () => {
    expect(validateApiKey(validKey, null)).toBe(false);
    expect(validateApiKey(validKey, undefined)).toBe(false);
    expect(validateApiKey(validKey, '')).toBe(false);
  });

  it('returns false when both keys are empty', () => {
    expect(validateApiKey('', '')).toBe(false);
    expect(validateApiKey(null, null)).toBe(false);
    expect(validateApiKey(undefined, undefined)).toBe(false);
  });
});
