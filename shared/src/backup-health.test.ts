import { describe, expect, it } from 'vitest';
import { BackupHealthResponseSchema } from './backup-health.js';

const answer = {
  status: 'healthy',
  timestamp: '2026-10-06T00:00:00Z',
  lastBackup: {
    date: '20261006',
    timestamp: '2026-10-06T00:00:00Z',
    ageHours: 1,
    manifest: { version: '1', kv: { totalRoutes: 3, domains: ['example.com'] } },
    files: [{ key: 'kv.ndjson.gz', size: 10, exists: true }],
    archive: { records: 3, inflatedBytes: 100 },
  },
  issues: [],
  checks: {
    backupExists: true,
    backupAge: 'ok',
    manifestValid: true,
    filesComplete: true,
    routeCountOk: true,
  },
};

describe('the backup health answer, defined once (v1.38.0)', () => {
  it('accepts the answer the Worker sends, archive null or verified', () => {
    expect(BackupHealthResponseSchema.parse(answer)).toEqual(answer);
    const unverified = { ...answer, lastBackup: { ...answer.lastBackup, archive: null } };
    expect(BackupHealthResponseSchema.safeParse(unverified).success).toBe(true);
  });

  it('requires the archive field the Worker always sends', () => {
    const { archive: _archive, ...withoutArchive } = answer.lastBackup;
    expect(
      BackupHealthResponseSchema.safeParse({ ...answer, lastBackup: withoutArchive }).success,
    ).toBe(false);
  });
});
