import { describe, it, expect } from 'vitest';
import {
  KVError,
  KVReadError,
  KVWriteError,
  KVDeleteError,
  KVListError,
  withKVErrorHandling,
  isKVError,
} from '../../src/utils/kv-errors';

describe('KVError classes', () => {
  describe('KVError', () => {
    it('creates error with message and operation', () => {
      const error = new KVError('Test error', 'read', 'test-key');
      expect(error.message).toBe('Test error');
      expect(error.operation).toBe('read');
      expect(error.key).toBe('test-key');
      expect(error.name).toBe('KVError');
    });

    it('includes cause when provided', () => {
      const cause = new Error('Original error');
      const error = new KVError('Test error', 'write', 'key', cause);
      expect(error.cause).toBe(cause);
    });
  });

  describe('KVReadError', () => {
    it('creates read error with correct message', () => {
      const error = new KVReadError('route:/test');
      expect(error.message).toContain('Failed to read');
      expect(error.operation).toBe('read');
      expect(error.key).toBe('route:/test');
      expect(error.name).toBe('KVReadError');
    });
  });

  describe('KVWriteError', () => {
    it('creates write error with correct message', () => {
      const error = new KVWriteError('route:/new');
      expect(error.message).toContain('Failed to write');
      expect(error.operation).toBe('write');
      expect(error.key).toBe('route:/new');
      expect(error.name).toBe('KVWriteError');
    });
  });

  describe('KVDeleteError', () => {
    it('creates delete error with correct message', () => {
      const error = new KVDeleteError('route:/old');
      expect(error.message).toContain('Failed to delete');
      expect(error.operation).toBe('delete');
      expect(error.key).toBe('route:/old');
      expect(error.name).toBe('KVDeleteError');
    });
  });

  describe('KVListError', () => {
    it('creates list error with correct message', () => {
      const error = new KVListError();
      expect(error.message).toContain('Failed to list');
      expect(error.operation).toBe('list');
      expect(error.key).toBeUndefined();
      expect(error.name).toBe('KVListError');
    });
  });
});

describe('withKVErrorHandling', () => {
  it('returns success result on successful operation', async () => {
    const result = await withKVErrorHandling(
      async () => 'success',
      () => new KVReadError('test')
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('success');
    }
  });

  it('returns error result on failed operation', async () => {
    const result = await withKVErrorHandling(
      async () => {
        throw new Error('Original error');
      },
      (cause) => new KVReadError('test', cause)
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(KVReadError);
      expect(result.error.cause?.message).toBe('Original error');
    }
  });

  it('handles non-Error throws', async () => {
    const result = await withKVErrorHandling(
      async () => {
        throw 'string error';
      },
      (cause) => new KVWriteError('test', cause)
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.cause?.message).toBe('string error');
    }
  });
});

describe('isKVError', () => {
  it('returns true for KVError instances', () => {
    expect(isKVError(new KVError('test', 'read'))).toBe(true);
    expect(isKVError(new KVReadError('key'))).toBe(true);
    expect(isKVError(new KVWriteError('key'))).toBe(true);
    expect(isKVError(new KVDeleteError('key'))).toBe(true);
    expect(isKVError(new KVListError())).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isKVError(new Error('test'))).toBe(false);
    expect(isKVError({ message: 'fake error' })).toBe(false);
    expect(isKVError(null)).toBe(false);
    expect(isKVError(undefined)).toBe(false);
  });
});
