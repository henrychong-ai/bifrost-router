/**
 * One copy of each plain guard and of the error-envelope reader (v1.38.0).
 * `isRecord`, `isString`, `isFiniteNumber` and `isOptional` live in
 * `shared/src/guards.ts`, and the reader of a failed answer's body
 * (`readErrorEnvelope`, `isErrorCode`) in `shared/src/error-envelope.ts`: the
 * Worker, the dashboard, the MCP server and the client import them, so "a
 * plain object" and "a machine code" mean the same thing on every side of a
 * boundary. This gate fails when a second definition appears, under one of
 * these names or as an inline plain-object test. Tests are not checked.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = ['src', 'shared/src', 'admin/src', 'mcp/src', 'slackbot/src'];
const SOURCE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

/** Each guard and where its one definition lives. */
const HOMES = {
  isRecord: 'shared/src/guards.ts',
  isString: 'shared/src/guards.ts',
  isFiniteNumber: 'shared/src/guards.ts',
  isOptional: 'shared/src/guards.ts',
  readErrorEnvelope: 'shared/src/error-envelope.ts',
  isErrorCode: 'shared/src/error-envelope.ts',
};
/** Names a second copy would plausibly take. */
const ALIASES = ['isPlainObject', 'isObject', 'absentOr', 'readErrorBody', 'readEnvelope'];
/** The inline plain-object test the guard replaces. */
const INLINE_OBJECT_TEST = /typeof (\w+) === 'object' && \1 !== null/;

function sourceFiles() {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (!['node_modules', 'dist', 'generated'].includes(name)) walk(path);
      } else if (SOURCE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) {
        files.push(relative(ROOT, path));
      }
    }
  };
  for (const root of SOURCES) walk(join(ROOT, root));
  return files;
}

/** Every `function name` or `const name =` definition of `name`, as `file`. */
export function definitions(files, read, name) {
  const pattern = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*[=:])`);
  return files.filter(file => pattern.test(read(file)));
}

const files = sourceFiles();
const read = file => readFileSync(join(ROOT, file), 'utf8');

test('each guard and the envelope reader are defined once, in shared', () => {
  for (const [name, home] of Object.entries(HOMES)) {
    assert.deepEqual(definitions(files, read, name), [home], name);
  }
});

test('no second copy under another name, and no inline plain-object test outside guards.ts', () => {
  // readErrorBody is the dashboard's thin wrapper OVER readErrorEnvelope
  const wrappers = new Set(['admin/src/lib/api-client.ts']);
  for (const name of ALIASES) {
    const found = definitions(files, read, name).filter(
      file =>
        !(name === 'readErrorBody' && wrappers.has(file)) &&
        !(name === 'readEnvelope' && file === 'shared/src/client.ts'),
    );
    assert.deepEqual(found, [], name);
  }
  assert.deepEqual(
    files.filter(file => file !== HOMES.isRecord && INLINE_OBJECT_TEST.test(read(file))),
    [],
  );
});

test('the wrappers read through the shared reader', () => {
  assert.match(read('admin/src/lib/api-client.ts'), /readErrorEnvelope\(/);
  assert.match(read('shared/src/client.ts'), /readErrorEnvelope\(/);
});

test('definitions() finds a function, a const and an annotated binding', () => {
  const fake = {
    'a.ts': 'export function isRecord(v) {}',
    'b.ts': 'const isRecord = v => v',
    'c.ts': 'const isRecord: Guard = x',
    'd.ts': 'isRecord(x)',
  };
  assert.deepEqual(
    definitions(Object.keys(fake), file => fake[file], 'isRecord'),
    ['a.ts', 'b.ts', 'c.ts'],
  );
});
