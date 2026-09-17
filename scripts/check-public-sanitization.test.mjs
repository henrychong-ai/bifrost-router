import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  publicCandidateFiles,
  sanitizationFindings,
  singleLabelHostFindings,
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

test('flags a single-label https host and accepts an RFC 2606 name', () => {
  // A single-label host is reserved by nothing: it reads as an internal
  // hostname and may one day resolve for somebody.
  assert.deepEqual(singleLabelHostFindings('see https://app/cb?token=x'), ['https://app']);
  assert.deepEqual(singleLabelHostFindings('see https://a.example/b'), []);
  assert.deepEqual(singleLabelHostFindings('http://example.com/x'), []);
  // The percent-encoded form a nested-URL example carries.
  assert.deepEqual(singleLabelHostFindings('?next=https%3A%2F%2Fapp%3Ftoken%3Dx'), [
    'https%3A%2F%2Fapp',
  ]);
  assert.deepEqual(singleLabelHostFindings('?next=https%3A%2F%2Fapp.example%3Ftoken%3Dx'), []);
  // localhost is reserved and means what it says.
  assert.deepEqual(singleLabelHostFindings('https://localhost:8787/health'), []);
  // Reported once however many times it appears.
  assert.deepEqual(singleLabelHostFindings('https://app/a https://app/b'), ['https://app']);
});
