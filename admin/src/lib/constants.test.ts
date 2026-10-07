import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  getPersistedPageSize,
  getR2ObjectUrl,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_STORAGE_KEY,
  persistPageSize,
  R2_BUCKET_CUSTOM_DOMAINS,
} from './constants';

// =============================================================================
// R2 Bucket Custom Domains
// =============================================================================

describe('R2_BUCKET_CUSTOM_DOMAINS', () => {
  // The public mirror ships with an empty R2 domain map.
  // Forkers: populate R2_BUCKET_CUSTOM_DOMAINS in constants.ts and update tests.
  test('is empty in the public mirror template', () => {
    expect(Object.keys(R2_BUCKET_CUSTOM_DOMAINS)).toHaveLength(0);
  });

  test('does not include bifrost-backups', () => {
    expect(R2_BUCKET_CUSTOM_DOMAINS).not.toHaveProperty('bifrost-backups');
  });
});

// =============================================================================
// getR2ObjectUrl
// =============================================================================

describe('getR2ObjectUrl', () => {
  // With an empty domain map, all lookups return null.
  // Forkers: after populating R2_BUCKET_CUSTOM_DOMAINS, add URL assertion tests.
  test('returns null for buckets not in the domain map', () => {
    expect(getR2ObjectUrl('files', 'photo.jpg')).toBeNull();
    expect(getR2ObjectUrl('assets', 'logo.svg')).toBeNull();
    expect(getR2ObjectUrl('nonexistent', 'file.txt')).toBeNull();
    expect(getR2ObjectUrl('bifrost-backups', 'backup.gz')).toBeNull();
  });

  describe('with a custom domain', () => {
    beforeEach(() => {
      R2_BUCKET_CUSTOM_DOMAINS['files'] = 'files.example.com';
      return () => {
        delete R2_BUCKET_CUSTOM_DOMAINS['files'];
      };
    });

    test('encodes each segment of a normal key', () => {
      expect(getR2ObjectUrl('files', 'docs/a b#1.pdf')).toBe(
        'https://files.example.com/docs/a%20b%231.pdf',
      );
    });

    // URL parsers resolve dot segments, so the link would open another object
    test('refuses a key with a dot segment, a leading slash or an empty segment', () => {
      for (const key of ['a/../b', './a', 'a/.', '/report.pdf', 'a//b', 'dir/']) {
        expect({ key, url: getR2ObjectUrl('files', key) }).toEqual({ key, url: null });
      }
    });
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
