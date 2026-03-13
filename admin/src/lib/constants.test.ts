import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  R2_BUCKET_CUSTOM_DOMAINS,
  getR2ObjectUrl,
  getPersistedPageSize,
  persistPageSize,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_STORAGE_KEY,
} from './constants';

// =============================================================================
// R2 Bucket Custom Domains
// =============================================================================

describe('R2_BUCKET_CUSTOM_DOMAINS', () => {
  test('is a Record<string, string>', () => {
    expect(typeof R2_BUCKET_CUSTOM_DOMAINS).toBe('object');
  });

  test('does not include bifrost-backups by default', () => {
    expect(R2_BUCKET_CUSTOM_DOMAINS).not.toHaveProperty('bifrost-backups');
  });

  test('all values are valid hostnames when configured', () => {
    for (const domain of Object.values(R2_BUCKET_CUSTOM_DOMAINS)) {
      expect(domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    }
  });
});

// =============================================================================
// getR2ObjectUrl
// =============================================================================

describe('getR2ObjectUrl', () => {
  test('returns null for unconfigured bucket', () => {
    expect(getR2ObjectUrl('nonexistent', 'file.txt')).toBeNull();
  });

  test('returns null for bifrost-backups', () => {
    expect(getR2ObjectUrl('bifrost-backups', 'backup.gz')).toBeNull();
  });

  test('encodes spaces in key', () => {
    // Temporarily add a domain for testing URL encoding
    const original = R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
    R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = 'files.example.com';
    try {
      expect(getR2ObjectUrl('test-bucket', 'my file.pdf')).toBe(
        'https://files.example.com/my%20file.pdf',
      );
    } finally {
      if (original === undefined) delete R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
      else R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = original;
    }
  });

  test('encodes special characters in key', () => {
    R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = 'files.example.com';
    try {
      expect(getR2ObjectUrl('test-bucket', 'Q1 Report (2025).pdf')).toBe(
        'https://files.example.com/Q1%20Report%20(2025).pdf',
      );
    } finally {
      delete R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
    }
  });

  test('preserves slashes as path separators', () => {
    R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = 'files.example.com';
    try {
      expect(getR2ObjectUrl('test-bucket', 'docs/report.pdf')).toBe(
        'https://files.example.com/docs/report.pdf',
      );
    } finally {
      delete R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
    }
  });

  test('handles deeply nested paths', () => {
    R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = 'files.example.com';
    try {
      expect(getR2ObjectUrl('test-bucket', 'a/b/c/d.txt')).toBe(
        'https://files.example.com/a/b/c/d.txt',
      );
    } finally {
      delete R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
    }
  });

  test('encodes each path segment independently', () => {
    R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = 'files.example.com';
    try {
      expect(getR2ObjectUrl('test-bucket', 'my docs/Q1 Report.pdf')).toBe(
        'https://files.example.com/my%20docs/Q1%20Report.pdf',
      );
    } finally {
      delete R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
    }
  });

  test('returns correct URL for configured bucket', () => {
    R2_BUCKET_CUSTOM_DOMAINS['test-bucket'] = 'files.example.com';
    try {
      expect(getR2ObjectUrl('test-bucket', 'photo.jpg')).toBe(
        'https://files.example.com/photo.jpg',
      );
    } finally {
      delete R2_BUCKET_CUSTOM_DOMAINS['test-bucket'];
    }
  });
});

// =============================================================================
// Page Size Persistence
// =============================================================================

describe('getPersistedPageSize', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns default when localStorage is unavailable', () => {
    expect(getPersistedPageSize()).toBe(DEFAULT_PAGE_SIZE);
  });

  test('returns stored value when valid', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    storage.set(PAGE_SIZE_STORAGE_KEY, '100');
    expect(getPersistedPageSize()).toBe(100);
  });

  test('returns default when stored value is not a valid option', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    storage.set(PAGE_SIZE_STORAGE_KEY, '999');
    expect(getPersistedPageSize()).toBe(DEFAULT_PAGE_SIZE);
  });

  test('returns default when stored value is not a number', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    storage.set(PAGE_SIZE_STORAGE_KEY, 'abc');
    expect(getPersistedPageSize()).toBe(DEFAULT_PAGE_SIZE);
  });

  test('returns default when nothing stored', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });

    expect(getPersistedPageSize()).toBe(DEFAULT_PAGE_SIZE);
  });

  test('accepts all valid page size options', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    for (const size of PAGE_SIZE_OPTIONS) {
      storage.set(PAGE_SIZE_STORAGE_KEY, String(size));
      expect(getPersistedPageSize()).toBe(size);
    }
  });
});

describe('persistPageSize', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test('writes value to localStorage', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    persistPageSize(100);
    expect(storage.get(PAGE_SIZE_STORAGE_KEY)).toBe('100');
  });

  test('does not throw when localStorage is unavailable', () => {
    expect(() => persistPageSize(50)).not.toThrow();
  });
});
