import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('nginx dashboard has a static-bundle CSP and baseline browser headers', () => {
  const config = readFileSync('admin/nginx.conf', 'utf8');
  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /script-src 'self'/);
  assert.match(config, /object-src 'none'/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(config, /unsafe-eval/);
});

test('request logs do not persist configured route targets', () => {
  const worker = readFileSync('src/index.ts', 'utf8');
  assert.doesNotMatch(worker, /target:\s*route\.target/);
});
