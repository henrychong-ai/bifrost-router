/**
 * The dashboard's build target (Vite's default browser baseline) includes
 * browsers without ES2023's array methods, and the bundler does not polyfill
 * them (v1.38.0). This gate fails when dashboard code, or shared code the
 * dashboard bundles, calls one: `toSorted`, `toReversed`, `toSpliced`, `with`,
 * `findLast` or `findLastIndex`. Use a copy and the ES2022 method instead
 * (`items.slice().sort(…)`). Tests are not bundled and are not checked;
 * `admin/src/lib/array-baseline.test.ts` runs the list helpers with the
 * methods removed.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLED = ['admin/src', 'shared/src'];
const SOURCE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
export const ES2023_ARRAY_CALL =
  /\.(?:toSorted|toReversed|toSpliced|with|findLast|findLastIndex)\(/;

/** Every bundled source file, repository-relative. */
function bundledFiles() {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'dist') walk(path);
      } else if (SOURCE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) {
        files.push(relative(ROOT, path));
      }
    }
  };
  for (const root of BUNDLED) walk(join(ROOT, root));
  return files;
}

test('the pattern catches each ES2023 array call and nothing else', () => {
  for (const call of [
    'rows.toSorted((a, b) => a - b)',
    'rows.toReversed()',
    'rows.toSpliced(0, 1)',
    'rows.with(0, x)',
    'rows.findLast(Boolean)',
    'rows.findLastIndex(Boolean)',
  ]) {
    assert.match(call, ES2023_ARRAY_CALL, call);
  }
  for (const call of ['rows.slice().sort()', 'rows.find(Boolean)', 'withCredentials(x)']) {
    assert.doesNotMatch(call, ES2023_ARRAY_CALL, call);
  }
});

test('dashboard-bundled code calls no ES2023 array method', () => {
  const files = bundledFiles();
  assert.ok(files.length > 50, 'the dashboard and shared sources were found');
  const found = [];
  for (const file of files) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (ES2023_ARRAY_CALL.test(line)) found.push(`${file}:${index + 1}`);
    }
  }
  assert.deepEqual(found, []);
});
