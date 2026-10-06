import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ciTestRuns,
  coveragePackages,
  packagesWithTests,
  untestedPackages,
} from './check-ci-test-coverage.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./check-ci-test-coverage.mjs', import.meta.url));

describe('the real repository', () => {
  test('every workspace package with tests is run by CI', () => {
    assert.deepEqual(untestedPackages('.'), []);
  });

  test('the four live packages run under coverage and slackbot runs plainly', () => {
    assert.deepEqual([...coveragePackages('.')].toSorted(), ['.', 'admin', 'mcp', 'shared']);
    const { runsCoverageAll, plain } = ciTestRuns('.');
    assert.equal(runsCoverageAll, true);
    assert.deepEqual([...plain], ['slackbot']);
  });

  test('all five packages are detected as having tests', () => {
    assert.deepEqual(packagesWithTests('.'), ['.', 'admin', 'mcp', 'shared', 'slackbot']);
  });
});

/** Writes a minimal workspace shaped like this repository. */
async function writeFixture(root, { packages, extra = {} }) {
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    `packages:\n${packages.map(dir => `  - "${dir}"`).join('\n')}\n`,
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        test: 'vitest run',
        'test:coverage': 'vitest run --coverage',
        'test:coverage:all': 'pnpm run test:coverage && pnpm -C shared exec vitest run --coverage',
      },
    }),
  );
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'root.test.ts'), '');
  for (const dir of ['shared', 'slackbot']) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(
      join(root, dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
  }
  for (const [file, content] of Object.entries(extra)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), content);
  }
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(
    join(root, '.github', 'workflows', 'ci.yml'),
    [
      'jobs:',
      '  ci:',
      '    steps:',
      '      - name: Tests + coverage gates',
      '        run: pnpm run test:coverage:all',
      '      - name: Test (slackbot)',
      '        run: pnpm -C slackbot test',
      '',
    ].join('\n'),
  );
}

describe('fixtures', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ci-test-coverage-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a covered workspace passes', async () => {
    const dir = join(root, 'pass');
    await mkdir(dir);
    await writeFixture(dir, { packages: ['.', 'shared', 'slackbot'] });
    assert.deepEqual(untestedPackages(dir), []);
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, dir]);
    assert.match(stdout, /Every workspace package with tests is run by CI/);
  });

  test('a new package with a test script and no CI run fails', async () => {
    const dir = join(root, 'script');
    await mkdir(dir);
    await writeFixture(dir, {
      packages: ['.', 'shared', 'slackbot', 'fake'],
      extra: { 'fake/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
    });
    assert.deepEqual(untestedPackages(dir), ['fake']);
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, dir]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /CI runs no tests for: fake\./);
      return true;
    });
  });

  test('a new package with test files but no test script fails', async () => {
    const dir = join(root, 'files');
    await mkdir(dir);
    await writeFixture(dir, {
      packages: ['.', 'shared', 'slackbot', 'pkgs/*'],
      extra: {
        'pkgs/fake/package.json': JSON.stringify({ name: 'fake' }),
        'pkgs/fake/src/thing.test.ts': '',
      },
    });
    assert.deepEqual(untestedPackages(dir), ['pkgs/fake']);
  });

  test('a package dropped from test:coverage:all fails', async () => {
    const dir = join(root, 'dropped');
    await mkdir(dir);
    await writeFixture(dir, { packages: ['.', 'shared', 'slackbot'] });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          'test:coverage': 'vitest run --coverage',
          'test:coverage:all': 'pnpm run test:coverage',
        },
      }),
    );
    assert.deepEqual(untestedPackages(dir), ['shared']);
  });

  test('a package with no test script or test files is ignored', async () => {
    const dir = join(root, 'untested');
    await mkdir(dir);
    await writeFixture(dir, {
      packages: ['.', 'shared', 'slackbot', 'docs-only'],
      extra: { 'docs-only/package.json': JSON.stringify({ name: 'docs-only' }) },
    });
    assert.deepEqual(untestedPackages(dir), []);
  });
});
