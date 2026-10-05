/**
 * Synthetic recovery rehearsal:
 * a real archive written by the backup job, verified, restored into an empty
 * KV namespace, then exercised through the Worker. Isolated workerd bindings
 * only; this is not a production recovery claim.
 */

import { env, SELF } from 'cloudflare:test';
import { QRDesignSchema } from '@bifrost/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseBackupManifest } from '../../src/backup/integrity';
import { backupKV } from '../../src/backup/kv';
import { clearAllRoutes } from '../helpers';
import { readBackupRecords } from './archive-records';

const now = Date.now();
const ADMIN_KEY = 'test-api-key-12345'; // gitleaks:allow — test binding, not a credential

const records = [
  {
    key: 'links.example.com:/recovery',
    value: {
      path: '/recovery',
      type: 'redirect',
      target: 'https://example.com/recovered',
      statusCode: 302,
      preserveQuery: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  },
  {
    key: 'example.com:/recovery-file',
    value: {
      path: '/recovery-file',
      type: 'r2',
      target: 'recovery/recovery.txt',
      bucket: 'files',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  },
  {
    key: 'example.com:/recovery-off',
    value: {
      path: '/recovery-off',
      type: 'redirect',
      target: 'https://example.com/off',
      statusCode: 302,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
  },
  {
    key: 'qr:example.com:recovery-fixture',
    value: {
      id: 'recovery-fixture',
      domain: 'example.com',
      type: 'url',
      payload: { url: 'https://example.com/recovery-file' },
      linkedRoute: { domain: 'example.com', path: '/recovery-file' },
      design: QRDesignSchema.parse({}),
      createdAt: now,
      updatedAt: now,
      createdBy: 'fixture',
    },
  },
];

async function restoreFixture(): Promise<void> {
  for (const record of records) await env.ROUTES.put(record.key, JSON.stringify(record.value));
  const date = '20261005';
  const kv = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);
  const manifest = parseBackupManifest({ version: '2.0.0', timestamp: now, date, kv }, date);
  const recovered = await readBackupRecords(env.BACKUP_BUCKET, manifest);

  // Lose the namespace, then restore it from the verified archive alone
  await clearAllRoutes();
  await env.ROUTES.delete('qr:example.com:recovery-fixture');
  expect((await env.ROUTES.list()).keys).toHaveLength(0);
  for (const record of recovered) await env.ROUTES.put(record.key, JSON.stringify(record.value));
  expect(recovered).toHaveLength(records.length);
}

/** The restored r2 route, as a public visitor requests it. */
const requestRecoveredFile = () => SELF.fetch('https://example.com/recovery-file');

describe('restored application behaviour', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await env.FILES_BUCKET.delete('recovery/recovery.txt');
    await restoreFixture();
  });

  it('restores every record exactly as it was stored', async () => {
    const restored = new Map<string, unknown>();
    for (const record of records)
      restored.set(record.key, await env.ROUTES.get(record.key, 'json'));
    expect(restored).toEqual(new Map(records.map(record => [record.key, record.value])));
  });

  it('serves the restored redirect with its query handling, and keeps a disabled route off', async () => {
    const res = await SELF.fetch('https://links.example.com/recovery?source=test', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/recovered?source=test');

    const off = await SELF.fetch('https://example.com/recovery-off', { redirect: 'manual' });
    expect(off.status).not.toBe(302);
    expect(off.headers.get('location')).toBeNull();
  });

  it('reads the restored QR code through the authenticated API only', async () => {
    const url = 'http://localhost/api/qr/recovery-fixture?domain=example.com';
    expect((await SELF.fetch(url)).status).toBe(401);
    const res = await SELF.fetch(url, { headers: { 'X-Admin-Key': ADMIN_KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        id: 'recovery-fixture',
        linkedRoute: { domain: 'example.com', path: '/recovery-file' },
        payload: { url: 'https://example.com/recovery-file' },
      },
    });
  });

  it('restores the r2 route but not its file: R2 content is recovered separately', async () => {
    expect((await requestRecoveredFile()).status).toBe(404);
    await env.FILES_BUCKET.put('recovery/recovery.txt', 'Recovered fixture', {
      httpMetadata: { contentType: 'text/plain' },
    });
    const served = await requestRecoveredFile();
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('Recovered fixture');
  });
});
