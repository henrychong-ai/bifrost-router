import { describe, it, expect } from 'vitest';
import type { AuditAction, AuditLog } from '@/lib/schemas';
import {
  computeNavTargets,
  parseDetails,
  parseDetailsObject,
  prettyPrintDetails,
} from './audit-format';

// Build a minimal AuditLog for computeNavTargets (which accepts a Pick).
function makeLog(
  partial: Partial<Pick<AuditLog, 'action' | 'domain' | 'path' | 'details'>> & {
    action: AuditAction;
  },
): Pick<AuditLog, 'action' | 'domain' | 'path' | 'details'> {
  return {
    domain: 'links.example.com',
    path: null,
    details: null,
    ...partial,
  };
}

// =============================================================================
// parseDetails
// =============================================================================

describe('parseDetails', () => {
  it('returns "-" for null', () => {
    expect(parseDetails(null)).toBe('-');
  });

  it('returns "-" for empty string', () => {
    expect(parseDetails('')).toBe('-');
  });

  it('formats toggle enabled=true as "Enabled"', () => {
    expect(parseDetails(JSON.stringify({ enabled: true }))).toBe('Enabled');
  });

  it('formats toggle enabled=false as "Disabled"', () => {
    expect(parseDetails(JSON.stringify({ enabled: false }))).toBe('Disabled');
  });

  it('formats seed count as "N routes"', () => {
    expect(parseDetails(JSON.stringify({ count: 12 }))).toBe('12 routes');
  });

  it('formats migrate oldPath/newPath as "old -> new"', () => {
    expect(parseDetails(JSON.stringify({ oldPath: '/old', newPath: '/new' }))).toBe('/old -> /new');
  });

  it('formats R2 move source -> destination', () => {
    expect(
      parseDetails(
        JSON.stringify({
          sourceBucket: 'files',
          destinationBucket: 'assets',
          key: 'old.pdf',
          destinationKey: 'new.pdf',
        }),
      ),
    ).toBe('files/old.pdf → assets/new.pdf');
  });

  it('formats R2 move with destinationKey falling back to key', () => {
    expect(
      parseDetails(
        JSON.stringify({
          sourceBucket: 'files',
          destinationBucket: 'assets',
          key: 'report.pdf',
        }),
      ),
    ).toBe('files/report.pdf → assets/report.pdf');
  });

  it('formats R2 replace with old and new size in bytes', () => {
    expect(
      parseDetails(
        JSON.stringify({
          bucket: 'files',
          key: 'doc.pdf',
          size: 2048,
          replaced: { size: 1024 },
        }),
      ),
    ).toBe('files/doc.pdf (1024 → 2048 bytes)');
  });

  it('formats R2 bucket/key info', () => {
    expect(parseDetails(JSON.stringify({ bucket: 'files', key: 'photo.jpg' }))).toBe(
      'files/photo.jpg',
    );
  });

  it('formats a route summary with target', () => {
    expect(parseDetails(JSON.stringify({ route: { target: 'https://example.com' } }))).toBe(
      'Target: https://example.com',
    );
  });

  it('formats a route summary without target as "Route data"', () => {
    expect(parseDetails(JSON.stringify({ route: {} }))).toBe('Route data');
  });

  it('formats before/after as "Modified route"', () => {
    expect(parseDetails(JSON.stringify({ before: {}, after: {} }))).toBe('Modified route');
  });

  it('falls back to truncated JSON for unrecognised objects', () => {
    expect(parseDetails(JSON.stringify({ foo: 'bar' }))).toBe('{"foo":"bar"}');
  });

  it('returns truncated raw string for malformed JSON', () => {
    expect(parseDetails('not json at all')).toBe('not json at all');
  });
});

// =============================================================================
// parseDetailsObject
// =============================================================================

describe('parseDetailsObject', () => {
  it('returns the parsed object for valid JSON object', () => {
    expect(parseDetailsObject(JSON.stringify({ bucket: 'files', key: 'a.pdf' }))).toEqual({
      bucket: 'files',
      key: 'a.pdf',
    });
  });

  it('returns null for null input', () => {
    expect(parseDetailsObject(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDetailsObject('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseDetailsObject('{ not valid')).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(parseDetailsObject(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  it('returns null for a JSON primitive (number)', () => {
    expect(parseDetailsObject('42')).toBeNull();
  });

  it('returns null for a JSON primitive (string)', () => {
    expect(parseDetailsObject(JSON.stringify('hello'))).toBeNull();
  });

  it('returns null for JSON null literal', () => {
    expect(parseDetailsObject('null')).toBeNull();
  });
});

// =============================================================================
// prettyPrintDetails
// =============================================================================

describe('prettyPrintDetails', () => {
  it('pretty-prints a valid object as multi-line 2-space JSON', () => {
    const result = prettyPrintDetails(JSON.stringify({ bucket: 'files', key: 'a.pdf' }));
    expect(result).toBe('{\n  "bucket": "files",\n  "key": "a.pdf"\n}');
    expect(result).toContain('\n');
  });

  it('returns the raw string for invalid JSON', () => {
    expect(prettyPrintDetails('not json')).toBe('not json');
  });

  it('returns the raw string for a JSON array (non-object)', () => {
    expect(prettyPrintDetails('[1,2,3]')).toBe('[1,2,3]');
  });

  it('returns "" for null', () => {
    expect(prettyPrintDetails(null)).toBe('');
  });

  it('returns "" for empty string', () => {
    expect(prettyPrintDetails('')).toBe('');
  });
});

// =============================================================================
// computeNavTargets
// =============================================================================

describe('computeNavTargets', () => {
  it('cf_config_change: emits NO targets (path is resource.type/resource.id, not bucket/key)', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'cf_config_change',
        domain: 'storage',
        path: 'queue/bifrost-r2-events',
        details: JSON.stringify({ cf_audit_id: 'abc', actionType: 'update' }),
      }),
    );
    expect(targets).toEqual([]);
  });

  it('create: emits a single route target labelled "Open route"', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'create', domain: 'links.example.com', path: '/github' }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'links.example.com', path: '/github' },
    ]);
  });

  it('update: emits a single route target', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'update', domain: 'example.com', path: '/blog' }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'example.com', path: '/blog' },
    ]);
  });

  it('delete: emits a route target', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'delete', domain: 'links.example.com', path: '/old-link' }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'links.example.com', path: '/old-link' },
    ]);
  });

  it('toggle: emits a route target', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'toggle',
        domain: 'links.example.com',
        path: '/x',
        details: JSON.stringify({ enabled: false }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'links.example.com', path: '/x' },
    ]);
  });

  it('seed: emits no targets (bulk operation)', () => {
    expect(
      computeNavTargets(
        makeLog({ action: 'seed', path: null, details: JSON.stringify({ count: 10 }) }),
      ),
    ).toEqual([]);
  });

  it('migrate: emits new route then "Open previous route"', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'migrate',
        domain: 'links.example.com',
        path: '/new',
        details: JSON.stringify({ oldPath: '/old', newPath: '/new' }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'links.example.com', path: '/new' },
      {
        kind: 'route',
        label: 'Open previous route',
        domain: 'links.example.com',
        path: '/old',
      },
    ]);
  });

  it('migrate: emits only the new target when oldPath is missing', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'migrate',
        domain: 'links.example.com',
        path: '/new',
        details: JSON.stringify({ newPath: '/new' }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'links.example.com', path: '/new' },
    ]);
  });

  it('r2_upload: emits a single storage target from path "bucket/key"', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'r2_upload', domain: 'storage', path: 'files/report.pdf' }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'files', key: 'report.pdf' },
    ]);
  });

  it('r2_upload: derives nested key from path correctly', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'r2_upload', domain: 'storage', path: 'files/docs/q1/report.pdf' }),
    );
    expect(targets).toEqual([
      {
        kind: 'storage',
        label: 'View file in storage',
        bucket: 'files',
        key: 'docs/q1/report.pdf',
      },
    ]);
  });

  it('r2_move: emits destination storage target then "View previous file"', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'r2_move',
        domain: 'storage',
        path: 'files/old.pdf',
        details: JSON.stringify({
          sourceBucket: 'files',
          destinationBucket: 'assets',
          key: 'old.pdf',
          destinationKey: 'new.pdf',
        }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'assets', key: 'new.pdf' },
      { kind: 'storage', label: 'View previous file', bucket: 'files', key: 'old.pdf' },
    ]);
  });

  it('r2_move: falls back to key when destinationKey is absent', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'r2_move',
        domain: 'storage',
        details: JSON.stringify({
          sourceBucket: 'files',
          destinationBucket: 'assets',
          key: 'report.pdf',
        }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'assets', key: 'report.pdf' },
      { kind: 'storage', label: 'View previous file', bucket: 'files', key: 'report.pdf' },
    ]);
  });

  it('r2_rename: emits new-key storage target then "View previous file"', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'r2_rename',
        domain: 'storage',
        details: JSON.stringify({
          bucket: 'files',
          oldKey: 'old-name.pdf',
          newKey: 'new-name.pdf',
        }),
      }),
    );
    expect(targets).toEqual([
      {
        kind: 'storage',
        label: 'View file in storage',
        bucket: 'files',
        key: 'new-name.pdf',
      },
      {
        kind: 'storage',
        label: 'View previous file',
        bucket: 'files',
        key: 'old-name.pdf',
      },
    ]);
  });

  it('r2_rename: emits only the new target when oldKey is missing', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'r2_rename',
        domain: 'storage',
        details: JSON.stringify({ bucket: 'files', newKey: 'new-name.pdf' }),
      }),
    );
    expect(targets).toEqual([
      {
        kind: 'storage',
        label: 'View file in storage',
        bucket: 'files',
        key: 'new-name.pdf',
      },
    ]);
  });

  it('r2_delete: derives storage target from path "bucket/key"', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'r2_delete', domain: 'storage', path: 'assets/logo.svg' }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'assets', key: 'logo.svg' },
    ]);
  });

  it('storage domain with non-r2 action splits generic path "bucket/key"', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'update', domain: 'storage', path: 'assets/manual.pdf' }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'assets', key: 'manual.pdf' },
    ]);
  });

  it('storage: falls back to details bucket/key when path is null', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'r2_upload',
        domain: 'storage',
        path: null,
        details: JSON.stringify({ bucket: 'files', key: 'fallback.pdf' }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'files', key: 'fallback.pdf' },
    ]);
  });

  it('storage: emits no targets when path has no slash and no details', () => {
    expect(
      computeNavTargets(makeLog({ action: 'r2_upload', domain: 'storage', path: 'files' })),
    ).toEqual([]);
  });

  it('storage: emits no targets when path and details are both absent', () => {
    expect(
      computeNavTargets(makeLog({ action: 'r2_delete', domain: 'storage', path: null })),
    ).toEqual([]);
  });

  it('route: emits no targets when path is null', () => {
    expect(computeNavTargets(makeLog({ action: 'create', path: null }))).toEqual([]);
  });

  it('route: emits no targets when path is empty', () => {
    expect(computeNavTargets(makeLog({ action: 'update', path: '' }))).toEqual([]);
  });

  it('transfer: emits new-domain route then "Open previous route" (same path)', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'transfer',
        domain: 'secondary.example.net',
        path: '/promo',
        details: JSON.stringify({
          fromDomain: 'links.example.com',
          toDomain: 'secondary.example.net',
          path: '/promo',
        }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'secondary.example.net', path: '/promo' },
      {
        kind: 'route',
        label: 'Open previous route',
        domain: 'links.example.com',
        path: '/promo',
      },
    ]);
  });

  it('transfer: falls back to record domain/path and omits previous when details are sparse', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'transfer', domain: 'links.example.com', path: '/x', details: '{}' }),
    );
    expect(targets).toEqual([
      { kind: 'route', label: 'Open route', domain: 'links.example.com', path: '/x' },
    ]);
  });

  it('r2_replace: derives storage target from path "bucket/key"', () => {
    const targets = computeNavTargets(
      makeLog({
        action: 'r2_replace',
        domain: 'storage',
        path: 'assets/banner.png',
        details: JSON.stringify({ bucket: 'assets', key: 'banner.png', size: 2048 }),
      }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'assets', key: 'banner.png' },
    ]);
  });

  it('r2_metadata_update: derives storage target from path "bucket/key"', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'r2_metadata_update', domain: 'storage', path: 'files/doc.pdf' }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'files', key: 'doc.pdf' },
    ]);
  });

  it('r2_cache_purge: derives storage target from path "bucket/key"', () => {
    const targets = computeNavTargets(
      makeLog({ action: 'r2_cache_purge', domain: 'storage', path: 'assets/style.css' }),
    );
    expect(targets).toEqual([
      { kind: 'storage', label: 'View file in storage', bucket: 'assets', key: 'style.css' },
    ]);
  });
});

// =============================================================================
// parseDetails — r2_rename summary (regression for the bucket+oldKey+newKey branch)
// =============================================================================

describe('parseDetails (rename)', () => {
  it('formats r2_rename {bucket, oldKey, newKey} as "old -> new"', () => {
    expect(
      parseDetails(JSON.stringify({ bucket: 'files', oldKey: 'a.pdf', newKey: 'b.pdf' })),
    ).toBe('a.pdf -> b.pdf');
  });
});
