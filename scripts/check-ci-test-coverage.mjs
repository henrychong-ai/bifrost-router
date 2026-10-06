#!/usr/bin/env node
// Every workspace package with tests must be run by CI: either under coverage
// (`test:coverage:all`, run by the CI coverage step) or by a plain
// `pnpm -C <dir> test` step in .github/workflows/ci.yml. CI runs each test
// once, so a new package that is added to neither would never be tested.
//
// Usage: node scripts/check-ci-test-coverage.mjs [repo-root]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.claude', '.wrangler']);

/** Normalise a workspace directory to a posix path with no `./` prefix ('.' for the root). */
function normaliseDir(dir) {
  const normal = posix.normalize(dir.replaceAll('\\', '/')).replace(/\/$/, '');
  return normal === '' ? '.' : normal;
}

/** The workspace package directories named by pnpm-workspace.yaml. */
export function workspacePackages(root) {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
  const dirs = new Set();
  for (const entry of workspace.packages ?? []) {
    if (entry.startsWith('!')) {
      throw new Error(`Unsupported negated workspace pattern: ${entry}`);
    }
    const glob = entry.match(/^(.*?)\/\*$/);
    if (glob) {
      const parent = join(root, glob[1]);
      if (!existsSync(parent)) continue;
      for (const child of readdirSync(parent)) {
        if (existsSync(join(parent, child, 'package.json'))) {
          dirs.add(normaliseDir(`${glob[1]}/${child}`));
        }
      }
      continue;
    }
    if (/[*?[{]/.test(entry)) {
      throw new Error(`Unsupported workspace pattern: ${entry}`);
    }
    if (existsSync(join(root, entry, 'package.json'))) dirs.add(normaliseDir(entry));
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
      const stat = statSync(join(root, rel));
      if (stat.isDirectory()) {
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
  const all = new Set(packages);
  return packages.filter(dir => {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    if (manifest.scripts?.test) return true;
    const others = new Set([...all].filter(other => other !== dir));
    return hasTestFiles(root, dir, others);
  });
}

/** The commands of a shell line joined by `&&`, `;` or newlines. */
function commands(script) {
  return script
    .split(/&&|;|\n/)
    .map(command => command.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/** Package directories that `test:coverage:all` runs under coverage. */
export function coveragePackages(root) {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const dirs = new Set();
  for (const command of commands(scripts['test:coverage:all'] ?? '')) {
    if (command === 'pnpm run test:coverage') {
      if (/\bvitest run --coverage\b/.test(scripts['test:coverage'] ?? '')) dirs.add('.');
      continue;
    }
    const sub = command.match(/^pnpm -C (\S+) (?:exec )?vitest run (?:.*\s)?--coverage\b/);
    if (sub) dirs.add(normaliseDir(sub[1]));
  }
  return dirs;
}

/** What the CI workflow's steps run: the coverage chain, and plain test runs by package. */
export function ciTestRuns(root, workflowPath = '.github/workflows/ci.yml') {
  const workflow = parse(readFileSync(join(root, workflowPath), 'utf8'));
  let runsCoverageAll = false;
  const plain = new Set();
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      for (const command of commands(step.run)) {
        if (command === 'pnpm run test:coverage:all') runsCoverageAll = true;
        if (command === 'pnpm run test' || command === 'pnpm test') plain.add('.');
        if (command === 'pnpm run -r test' || command === 'pnpm -r test') plain.add('*');
        const sub = command.match(/^pnpm -C (\S+) (?:run )?test$/);
        if (sub) plain.add(normaliseDir(sub[1]));
      }
    }
  }
  return { runsCoverageAll, plain };
}

/** Packages with tests that CI runs neither under coverage nor plainly. */
export function untestedPackages(root) {
  const { runsCoverageAll, plain } = ciTestRuns(root);
  const covered = runsCoverageAll ? coveragePackages(root) : new Set();
  return packagesWithTests(root).filter(
    dir => !covered.has(dir) && !plain.has(dir) && !(plain.has('*') && dir !== '.'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  const missing = untestedPackages(root);
  if (missing.length > 0) {
    console.error(
      `CI runs no tests for: ${missing.join(', ')}. Add each to test:coverage:all, or give it a plain \`pnpm -C <dir> test\` step in .github/workflows/ci.yml.`,
    );
    process.exit(1);
  }
  console.log('Every workspace package with tests is run by CI.');
}
