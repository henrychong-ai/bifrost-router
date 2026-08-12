import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  publicCandidateFiles,
  sanitizationFindings,
  wranglerIdentifierFindings,
} from './check-public-sanitization.mjs';

test('rejects private tenant content and accepts public placeholders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bifrost-public-scan-'));
  const safe = join(directory, 'safe.txt');
  const unsafe = join(directory, 'unsafe.txt');
  writeFileSync(
    safe,
    'bifrost.example.com your-cloudflare-account-id op://Your-Vault/Cloudflare/API-Token',
  );
  writeFileSync(
    unsafe,
    'private.fusang.co /Users/henrychong/repos/private op://Personal/Cloudflare/token',
  );
  assert.deepEqual(sanitizationFindings([safe]), []);
  assert.equal(sanitizationFindings([unsafe]).length, 3);
});

test('rejects real-looking Wrangler identifiers', () => {
  assert.deepEqual(
    wranglerIdentifierFindings('id = "your-kv-namespace-id"\ndatabase_id = "your-d1-id"'),
    [],
  );
  assert.equal(wranglerIdentifierFindings('id = "0123456789abcdef0123456789abcdef"').length, 1);
});

test('scans tracked and untracked release candidates', () => {
  const candidates = publicCandidateFiles();
  assert.ok(candidates.includes('scripts/check-public-sanitization.test.mjs'));
  assert.ok(candidates.includes('test/performance/analytics-performance.test.ts'));
});
