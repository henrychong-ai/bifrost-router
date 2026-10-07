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

  test('the four packages run under coverage and none runs plainly', () => {
    assert.deepEqual([...coveragePackages('.')].toSorted(), ['.', 'admin', 'mcp', 'shared']);
    const { runsCoverageAll, plain } = ciTestRuns('.');
    assert.equal(runsCoverageAll, true);
    assert.deepEqual([...plain], []);
  });

  test('all four packages are detected as having tests', () => {
    assert.deepEqual(packagesWithTests('.'), ['.', 'admin', 'mcp', 'shared']);
  });
});

const ROOT_SCRIPTS = {
  test: 'vitest run',
  'test:coverage': 'vitest run --coverage',
  'test:coverage:all': 'pnpm run test:coverage && pnpm -C shared exec vitest run --coverage',
};

const COVERAGE_STEP = [
  '      - name: Tests + coverage gates',
  '        run: pnpm run test:coverage:all',
];
const PLAIN_STEP = ['      - name: Test (tools)', '        run: pnpm -C tools test'];

/** A ci.yml with one job; `jobLines` go under the job, `steps` under its steps. */
function workflow(steps = [...COVERAGE_STEP, ...PLAIN_STEP], jobLines = []) {
  return ['jobs:', '  ci:', ...jobLines, '    steps:', ...steps, ''].join('\n');
}

/**
 * Writes a minimal workspace shaped like this repository: root and shared
 * under coverage and a `tools` package run plainly. Options override any part of it.
 */
async function writeFixture(
  root,
  { packages = ['.', 'shared', 'tools'], scripts = ROOT_SCRIPTS, ci = workflow(), extra = {} } = {},
) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    `packages:\n${packages.map(dir => `  - "${dir}"`).join('\n')}\n`,
  );
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }));
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'root.test.ts'), '');
  for (const dir of ['shared', 'tools']) {
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
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), ci);
}

/** Runs the CLI and returns { code, stdout, stderr } without throwing. */
async function runCli(dir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, dir]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe('fixtures', () => {
  let root;
  let count = 0;
  const fixture = async options => {
    const dir = join(root, `f${count++}`);
    await writeFixture(dir, options);
    return dir;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ci-test-coverage-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a covered workspace passes', async () => {
    const dir = await fixture();
    assert.deepEqual(untestedPackages(dir), []);
    const result = await runCli(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Every workspace package with tests is run by CI/);
  });

  test('a single trailing dir/* is accepted', async () => {
    const dir = await fixture({
      packages: ['.', 'shared', 'tools', 'pkgs/*'],
      extra: {
        'pkgs/fake/package.json': JSON.stringify({ name: 'fake' }),
        'pkgs/fake/src/thing.test.ts': '',
      },
    });
    assert.deepEqual(untestedPackages(dir), ['pkgs/fake']);
  });

  test('a new package with a test script and no CI run fails', async () => {
    const dir = await fixture({
      packages: ['.', 'shared', 'tools', 'fake'],
      extra: { 'fake/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
    });
    assert.deepEqual(untestedPackages(dir), ['fake']);
    const result = await runCli(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CI runs no tests for: fake\./);
  });

  test('a package with test files but no test script fails', async () => {
    const dir = await fixture({
      packages: ['.', 'shared', 'tools', 'fake'],
      extra: {
        'fake/package.json': JSON.stringify({ name: 'fake' }),
        'fake/src/thing.test.ts': '',
      },
    });
    assert.deepEqual(untestedPackages(dir), ['fake']);
  });

  test('a package dropped from test:coverage:all fails', async () => {
    const dir = await fixture({
      scripts: { ...ROOT_SCRIPTS, 'test:coverage:all': 'pnpm run test:coverage' },
    });
    assert.deepEqual(untestedPackages(dir), ['shared']);
  });

  test('a package with no test script or test files is ignored', async () => {
    const dir = await fixture({
      packages: ['.', 'shared', 'tools', 'docs-only'],
      extra: { 'docs-only/package.json': JSON.stringify({ name: 'docs-only' }) },
    });
    assert.deepEqual(untestedPackages(dir), []);
  });

  for (const pattern of ['packages/*/*', 'packages/**/*', 'packages/**', '!skip', '*', '../x']) {
    test(`workspace pattern "${pattern}" is rejected`, async () => {
      const dir = await fixture({ packages: ['.', 'shared', 'tools', pattern] });
      assert.throws(() => untestedPackages(dir), /unsupported pattern|not a literal directory/);
      const result = await runCli(dir);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /CI test coverage check failed/);
    });
  }

  test('a coverage step with if: false earns no credit', async () => {
    const dir = await fixture({
      ci: workflow([...COVERAGE_STEP, '        if: false', ...PLAIN_STEP]),
    });
    assert.deepEqual(untestedPackages(dir), ['.', 'shared']);
  });

  test('a plain step with an if earns no credit', async () => {
    const dir = await fixture({
      ci: workflow([...COVERAGE_STEP, ...PLAIN_STEP, "        if: github.ref == 'x'"]),
    });
    assert.deepEqual(untestedPackages(dir), ['tools']);
  });

  test('a job-level if earns no credit for any step', async () => {
    const dir = await fixture({ ci: workflow(undefined, ['    if: false']) });
    assert.deepEqual(untestedPackages(dir), ['.', 'shared', 'tools']);
  });

  test('a step working-directory earns no credit', async () => {
    const dir = await fixture({
      ci: workflow([...COVERAGE_STEP, ...PLAIN_STEP, '        working-directory: shared']),
    });
    assert.deepEqual(untestedPackages(dir), ['tools']);
  });

  test('a job default working-directory earns no credit', async () => {
    const dir = await fixture({
      ci: workflow(undefined, ['    defaults:', '      run:', '        working-directory: shared']),
    });
    assert.deepEqual(untestedPackages(dir), ['.', 'shared', 'tools']);
  });

  test('continue-on-error earns no credit', async () => {
    const dir = await fixture({
      ci: workflow([...COVERAGE_STEP, ...PLAIN_STEP, '        continue-on-error: true']),
    });
    assert.deepEqual(untestedPackages(dir), ['tools']);
  });

  test('an echoed coverage command in the step earns no credit', async () => {
    const dir = await fixture({
      ci: workflow([
        '      - name: Tests + coverage gates',
        '        run: echo "pnpm run test:coverage:all"',
        ...PLAIN_STEP,
      ]),
    });
    assert.deepEqual(untestedPackages(dir), ['.', 'shared']);
  });

  test('an echoed plain test command earns no credit', async () => {
    const dir = await fixture({
      ci: workflow([
        ...COVERAGE_STEP,
        '      - name: Test (tools)',
        '        run: echo pnpm -C tools test',
      ]),
    });
    assert.deepEqual(untestedPackages(dir), ['tools']);
  });

  test('a test:coverage script that only echoes vitest fails', async () => {
    const dir = await fixture({
      scripts: { ...ROOT_SCRIPTS, 'test:coverage': 'echo "vitest run --coverage"' },
    });
    assert.throws(() => untestedPackages(dir), /test:coverage must be exactly/);
    assert.equal((await runCli(dir)).code, 1);
  });

  test('an echoed command inside test:coverage:all fails', async () => {
    const dir = await fixture({
      scripts: {
        ...ROOT_SCRIPTS,
        'test:coverage:all':
          'pnpm run test:coverage && echo "pnpm -C shared exec vitest run --coverage"',
      },
    });
    assert.throws(() => untestedPackages(dir), /unrecognised command/);
  });

  test('a ; or || chain in test:coverage:all fails', async () => {
    const dir = await fixture({
      scripts: {
        ...ROOT_SCRIPTS,
        'test:coverage:all': 'pnpm run test:coverage || pnpm -C shared exec vitest run --coverage',
      },
    });
    assert.throws(() => untestedPackages(dir), /unrecognised command/);
  });

  for (const command of [
    'pnpm run -r test',
    'pnpm -r test',
    'pnpm --recursive run test',
    'pnpm --filter ./tools test',
    'pnpm -F tools test',
  ]) {
    test(`multi-package command "${command}" is rejected`, async () => {
      const dir = await fixture({
        ci: workflow([...COVERAGE_STEP, '      - name: Test', `        run: ${command}`]),
      });
      assert.throws(() => untestedPackages(dir), /multi-package test command/);
      const result = await runCli(dir);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /multi-package test command/);
    });
  }
});
