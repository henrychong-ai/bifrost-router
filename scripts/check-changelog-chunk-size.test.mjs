import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHANGELOG_CHUNK_MAX_GZIP_BYTES,
  CHANGELOG_CHUNK_PATTERN,
  measureChangelogChunk,
} from './check-changelog-chunk-size.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./check-changelog-chunk-size.mjs', import.meta.url));

describe('changelog chunk ceiling', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'bifrost-chunk-gate-'));

    // A page-code-sized chunk.
    await mkdir(join(root, 'small/assets'), { recursive: true });
    await writeFile(join(root, 'small/assets/changelog-abc123.js'), 'export const x=1;');

    // A chunk carrying the markdown again. RANDOM bytes, because gzip finds
    // structure in anything patterned — a deterministic filler compresses well
    // under the ceiling and the fixture proves nothing.
    await mkdir(join(root, 'bloated/assets'), { recursive: true });
    await writeFile(
      join(root, 'bloated/assets/changelog-abc123.js'),
      randomBytes(CHANGELOG_CHUNK_MAX_GZIP_BYTES * 2),
    );

    // No chunk at all, and two chunks — both must fail closed.
    await mkdir(join(root, 'none/assets'), { recursive: true });
    await writeFile(join(root, 'none/assets/index-abc123.js'), 'export const x=1;');
    await mkdir(join(root, 'two/assets'), { recursive: true });
    await writeFile(join(root, 'two/assets/changelog-aaa.js'), 'export const x=1;');
    await writeFile(join(root, 'two/assets/changelog-bbb.js'), 'export const x=2;');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the pattern matches a content-hashed chunk and nothing else', () => {
    assert.ok(CHANGELOG_CHUNK_PATTERN.test('assets/changelog-luvln_sS.js'));
    assert.ok(!CHANGELOG_CHUNK_PATTERN.test('assets/index-luvln_sS.js'));
    assert.ok(!CHANGELOG_CHUNK_PATTERN.test('assets/nested/changelog-x.js'));
  });

  test('passes a page-code-sized chunk', async () => {
    const { gzipBytes } = await measureChangelogChunk(join(root, 'small'));
    assert.ok(gzipBytes > 0);
    assert.ok(gzipBytes <= CHANGELOG_CHUNK_MAX_GZIP_BYTES);

    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT,
      '--dir',
      join(root, 'small'),
    ]);
    assert.match(stdout, /Changelog chunk: /);
  });

  test('FAILS when the markdown is back in the chunk', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'bloated')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /over the .* ceiling/);
        return true;
      },
    );
  });

  test('FAILS CLOSED on zero matches', async () => {
    const { gzipBytes } = await measureChangelogChunk(join(root, 'none'));
    assert.equal(gzipBytes, null);

    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'none')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /expected exactly 1 chunk/);
        return true;
      },
    );
  });

  test('FAILS CLOSED on more than one match', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'two')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /found 2/);
        return true;
      },
    );
  });

  test('FAILS CLOSED on a missing build directory', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'does-not-exist')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /could not scan/);
        return true;
      },
    );
  });

  test('FAILS on a bare --dir', async () => {
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, '--dir']), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--dir requires a directory path/);
      return true;
    });
  });
});
