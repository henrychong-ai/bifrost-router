#!/usr/bin/env node
// Every workspace package with tests must be run by CI: either under coverage
// (`test:coverage:all`, run by the CI coverage step) or by a plain
// `pnpm -C <dir> test` step in .github/workflows/ci.yml. CI runs each test
// once, so a new package that is added to neither would never be tested.
//
// The check is deliberately strict: it credits only the exact command shapes
// this repository uses, in steps that always run, and fails loudly on any
// workspace pattern or test command it does not understand.
//
// Usage: node scripts/check-ci-test-coverage.mjs [repo-root]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const WORKFLOW = '.github/workflows/ci.yml';
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.claude', '.wrangler']);

/** A literal relative directory: no wildcard, negation, `..`, or absolute path. */
const LITERAL_DIR = /^(?:\.|[\w@-][\w.@-]*(?:\/[\w@-][\w.@-]*)*)$/;
const COVERAGE_STEP = 'pnpm run test:coverage:all';
const PLAIN_STEP = /^pnpm -C ([\w.@/-]+) (?:run )?test$/;
const ROOT_COVERAGE = 'pnpm run test:coverage';
const PACKAGE_COVERAGE = /^pnpm -C ([\w.@/-]+) exec vitest run --coverage$/;
const VITEST_COVERAGE = 'vitest run --coverage';
/** Any pnpm invocation that runs tests across several packages. */
const MULTI_PACKAGE_TEST =
  /\bpnpm\b(?=.*\btest\b)(?=.*(?:\s-r\b|\s--recursive\b|\s--filter\b|\s-F\b))/;

/** Strip a trailing slash and a leading `./` from a literal directory. */
function normaliseDir(dir) {
  const trimmed = dir.replace(/\/+$/, '').replace(/^\.\/(?=.)/, '');
  return trimmed === '' ? '.' : trimmed;
}

function literalDir(dir, what) {
  const normal = normaliseDir(dir);
  if (!LITERAL_DIR.test(normal) || normal.split('/').includes('..')) {
    throw new Error(`${what}: "${dir}" is not a literal directory inside the repository`);
  }
  return normal;
}

/**
 * The workspace package directories named by pnpm-workspace.yaml. Only literal
 * directories and a single trailing `dir/*` are accepted; anything else throws.
 */
export function workspacePackages(root) {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
  const dirs = new Set();
  for (const entry of workspace.packages ?? []) {
    if (typeof entry !== 'string') throw new Error('pnpm-workspace.yaml: non-string package entry');
    if (entry.endsWith('/*')) {
      const parent = entry.slice(0, -2);
      if (!LITERAL_DIR.test(parent) || parent === '.') {
        throw new Error(
          `pnpm-workspace.yaml: unsupported pattern "${entry}" (only literal directories and a single trailing "dir/*" are allowed)`,
        );
      }
      if (!existsSync(join(root, parent))) continue;
      for (const child of readdirSync(join(root, parent))) {
        if (existsSync(join(root, parent, child, 'package.json'))) dirs.add(`${parent}/${child}`);
      }
      continue;
    }
    if (!LITERAL_DIR.test(normaliseDir(entry))) {
      throw new Error(
        `pnpm-workspace.yaml: unsupported pattern "${entry}" (only literal directories and a single trailing "dir/*" are allowed)`,
      );
    }
    const dir = literalDir(entry, 'pnpm-workspace.yaml');
    if (existsSync(join(root, dir, 'package.json'))) dirs.add(dir);
  }
  return [...dirs].toSorted();
}

/** True when `dir` holds a test file, not counting nested workspace packages. */
function hasTestFiles(root, dir, otherPackages) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(join(root, current))) {
      const rel = current === '.' ? name : `${current}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) {
        if (SKIP_DIRS.has(name) || otherPackages.has(rel)) continue;
        stack.push(rel);
      } else if (TEST_FILE.test(name)) {
        return true;
      }
    }
  }
  return false;
}

/** Workspace packages that have a `test` script or test files. */
export function packagesWithTests(root) {
  const packages = workspacePackages(root);
  return packages.filter(dir => {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    if (manifest.scripts?.test) return true;
    return hasTestFiles(root, dir, new Set(packages.filter(other => other !== dir)));
  });
}

/**
 * Package directories that `test:coverage:all` runs under coverage. The script
 * must be a plain `&&` chain of the two exact shapes this repository uses;
 * anything else throws.
 */
export function coveragePackages(root) {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const chain = scripts['test:coverage:all'];
  if (typeof chain !== 'string') throw new Error('package.json: no test:coverage:all script');
  const dirs = new Set();
  for (const part of chain.split('&&').map(command => command.trim())) {
    if (part === ROOT_COVERAGE) {
      if (scripts['test:coverage'] !== VITEST_COVERAGE) {
        throw new Error(`package.json: test:coverage must be exactly "${VITEST_COVERAGE}"`);
      }
      dirs.add('.');
      continue;
    }
    const sub = part.match(PACKAGE_COVERAGE);
    if (!sub) {
      throw new Error(`package.json: test:coverage:all has an unrecognised command "${part}"`);
    }
    dirs.add(literalDir(sub[1], 'test:coverage:all'));
  }
  return dirs;
}

/**
 * What the CI workflow always runs: whether an unconditional step runs exactly
 * `pnpm run test:coverage:all`, and which packages unconditional steps test
 * plainly with exactly `pnpm -C <dir> test`. Conditional jobs or steps,
 * `continue-on-error`, and any `working-directory` earn no credit. A
 * multi-package test command (`-r`, `--recursive`, `--filter`, `-F`) throws.
 */
export function ciTestRuns(root) {
  const workflow = parse(readFileSync(join(root, WORKFLOW), 'utf8')) ?? {};
  let runsCoverageAll = false;
  const plain = new Set();
  const workflowDir = workflow.defaults?.run?.['working-directory'];
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    const jobCredited =
      workflowDir === undefined &&
      job.if === undefined &&
      job['continue-on-error'] === undefined &&
      job.defaults?.run?.['working-directory'] === undefined;
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      for (const line of step.run.split('\n')) {
        if (MULTI_PACKAGE_TEST.test(line)) {
          throw new Error(
            `${WORKFLOW} (${name}): multi-package test command "${line.trim()}"; list each package with "pnpm -C <dir> test" instead`,
          );
        }
      }
      const credited =
        jobCredited &&
        step.if === undefined &&
        step['continue-on-error'] === undefined &&
        step['working-directory'] === undefined;
      if (!credited) continue;
      const command = step.run.trim();
      if (command === COVERAGE_STEP) runsCoverageAll = true;
      const sub = command.match(PLAIN_STEP);
      if (sub) plain.add(literalDir(sub[1], WORKFLOW));
    }
  }
  return { runsCoverageAll, plain };
}

/** Packages with tests that CI runs neither under coverage nor plainly. */
export function untestedPackages(root) {
  const { runsCoverageAll, plain } = ciTestRuns(root);
  const covered = runsCoverageAll ? coveragePackages(root) : new Set();
  return packagesWithTests(root).filter(dir => !covered.has(dir) && !plain.has(dir));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  let missing;
  try {
    missing = untestedPackages(root);
  } catch (error) {
    console.error(`CI test coverage check failed: ${error.message}`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(
      `CI runs no tests for: ${missing.join(', ')}. Add each to test:coverage:all, or give it an unconditional \`pnpm -C <dir> test\` step in ${WORKFLOW}.`,
    );
    process.exit(1);
  }
  console.log('Every workspace package with tests is run by CI.');
}
