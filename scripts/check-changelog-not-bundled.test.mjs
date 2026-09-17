import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChangelogHeadings, scanDirectory } from './check-changelog-not-bundled.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./check-changelog-not-bundled.mjs', import.meta.url));

/** A bundler inlines markdown as a JS string, so the newlines arrive escaped. */
const BUNDLED_CHUNK =
  'const c="# Changelog\\n\\n## v1.36.0 (2026-09-17)\\n\\n### Fixed\\n\\n- thing\\n";export{c};';

describe('findChangelogHeadings', () => {
  test('finds a heading written as a real line', () => {
    assert.deepEqual(findChangelogHeadings('# Changelog\n\n## v1.2.3 (2026-01-01)\n'), [
      '## v1.2.3 (',
    ]);
  });

  test('finds a heading escaped inside a JS string literal (the real regression)', () => {
    assert.deepEqual(findChangelogHeadings(BUNDLED_CHUNK), ['## v1.36.0 (']);
  });

  test('finds CRLF-escaped headings too', () => {
    assert.deepEqual(findChangelogHeadings('x="a\\r\\n## v9.9.9 (2026-01-01)"'), ['## v9.9.9 (']);
  });

  test('reports every heading, not just the first', () => {
    assert.equal(
      findChangelogHeadings('## v1.0.0 (2026-01-01)\n## v1.0.1 (2026-01-02)\n').length,
      2,
    );
  });

  test('does NOT match the parser own source regex', () => {
    // admin/src/lib/parse-changelog.ts ships this pattern into the bundle.
    const parserSource = String.raw`const RE_VERSION=/^## v([\d.]+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?/;`;
    assert.deepEqual(findChangelogHeadings(parserSource), []);
  });

  test('does not match an unrelated markdown heading or a mid-line mention', () => {
    assert.deepEqual(findChangelogHeadings('## Versioning\n\nsee v1.2.3 (old)\n'), []);
    assert.deepEqual(findChangelogHeadings('note: ## v1.2.3 (inline)'), []);
  });
});

describe('scanDirectory + CLI exit code', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'bifrost-changelog-gate-'));
    await mkdir(join(root, 'clean/assets'), { recursive: true });
    await writeFile(join(root, 'clean/index.html'), '<!doctype html><title>Bifrost</title>');
    await writeFile(join(root, 'clean/assets/changelog-abc123.js'), 'export const x=1;');
    await mkdir(join(root, 'dirty/assets'), { recursive: true });
    await writeFile(join(root, 'dirty/index.html'), '<!doctype html><title>Bifrost</title>');
    await writeFile(join(root, 'dirty/assets/changelog-abc123.js'), BUNDLED_CHUNK);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('passes on a build with no changelog text', async () => {
    const clean = await scanDirectory(join(root, 'clean'));
    assert.deepEqual(clean.offenders, []);
    assert.equal(clean.scanned, 2);
    assert.equal(clean.hasIndex, true);
    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT,
      '--dir',
      join(root, 'clean'),
    ]);
    assert.match(stdout, /No changelog release heading/);
  });

  test('FAILS on a build that re-imported the changelog', async () => {
    const { offenders } = await scanDirectory(join(root, 'dirty'));
    assert.equal(offenders.length, 1);
    assert.deepEqual(offenders[0].headings, ['## v1.36.0 (']);

    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'dirty')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /changelog is inside the dashboard bundle/);
        assert.match(error.stderr, /assets\/changelog-abc123\.js/);
        return true;
      },
    );
  });

  test('FAILS on an EMPTY directory — a pass must mean something was scanned', async () => {
    await mkdir(join(root, 'empty'), { recursive: true });
    const empty = await scanDirectory(join(root, 'empty'));
    assert.equal(empty.scanned, 0);

    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'empty')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /scanned 0 files/);
        return true;
      },
    );
  });

  test('FAILS on a directory with no index.html — not a dashboard build', async () => {
    await mkdir(join(root, 'not-a-build'), { recursive: true });
    await writeFile(join(root, 'not-a-build/notes.txt'), 'nothing to see');

    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'not-a-build')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /no index\.html/);
        return true;
      },
    );
  });

  test('FAILS when index.html is only NESTED, not at the root', async () => {
    await mkdir(join(root, 'nested-only/inner'), { recursive: true });
    await writeFile(join(root, 'nested-only/inner/index.html'), '<!doctype html>');

    const nested = await scanDirectory(join(root, 'nested-only'));
    assert.equal(nested.hasIndex, false);

    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--dir', join(root, 'nested-only')]),
      error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /no index\.html at the ROOT/);
        return true;
      },
    );
  });

  test('FAILS on a bare --dir instead of scanning the current directory', async () => {
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, '--dir']), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--dir requires a directory path/);
      return true;
    });
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
});
