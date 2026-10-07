import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkBoundaryReads,
  findBoundaryReads,
  isProductionSource,
} from './check-boundary-reads.mjs';

const patterns = (text, fileName) =>
  findBoundaryReads(text, fileName).map(({ line, pattern }) => `${line} ${pattern}`);

test('flags each unvalidated boundary read, with its line and pattern name', () => {
  assert.deepEqual(patterns("const a = await kv.get<Route>(key, 'json');"), ['1 kv-get-json']);
  assert.deepEqual(patterns('const a = await kv.get<Route>(key, { type: "json" });'), [
    '1 kv-get-json',
  ]);
  assert.deepEqual(
    patterns("const a = await kv.get<Record<string, Array<X>>>(\n  key,\n  'json',\n);"),
    ['1 kv-get-json'],
  );
  assert.deepEqual(patterns('const a = await response.json<Body>();'), ['1 json-generic']);
  assert.deepEqual(patterns('const a = await c.req.json<{\n  a?: string;\n}>();'), [
    '1 req-json-generic',
  ]);
  assert.deepEqual(patterns('const a = (await response.json()) as Body;'), ['1 json-await-as']);
  assert.deepEqual(patterns('const a = await response.json() as Body;'), ['1 json-await-as']);
  assert.deepEqual(patterns('const a = (\n  await r.json()\n) as { ok: boolean };'), [
    '2 json-await-as',
  ]);
  assert.deepEqual(patterns('const a = JSON.parse(text) as Cursor;'), ['1 json-parse-as']);
  assert.deepEqual(patterns('const a = JSON.parse(f(x, (y))) as Cursor;'), ['1 json-parse-as']);
  assert.deepEqual(patterns('const a = (JSON.parse(text)) as Cursor;'), ['1 json-parse-as']);
});

test('bans any KV json read, typed or not', () => {
  assert.deepEqual(patterns("const a = await kv.get<unknown>(key, 'json');"), ['1 kv-get-json']);
  assert.deepEqual(patterns("const a = await kv.get(key, 'json');"), ['1 kv-get-json']);
  assert.deepEqual(patterns('const a = await kv.get(key, { type: "json", cacheTtl: 60 });'), [
    '1 kv-get-json',
  ]);
  assert.deepEqual(patterns("const a = await kv.getWithMetadata<unknown, Meta>(key, 'json');"), [
    '1 kv-get-json',
  ]);
  assert.deepEqual(
    patterns("// boundary-ok: vetted fixture\nconst a = await kv.get(key, 'json');"),
    [],
  );
});

test('flags an untyped request body and a cast after .catch()', () => {
  assert.deepEqual(patterns('const body = await c.req.json();'), ['1 req-json-untyped']);
  assert.deepEqual(
    patterns('const b = (await c.req.json<unknown>().catch(() => ({}))) as { ids?: unknown };'),
    ['1 json-await-as'],
  );
  assert.deepEqual(patterns('const b = (await r.json().catch(() => null)) as Body;'), [
    '1 json-await-as',
  ]);
  assert.deepEqual(patterns('const b = await c.req.json<unknown>().catch(() => undefined);'), []);
});

test('reports exact lines around emoji and ignores reads inside comments', () => {
  const text = '// 🎉🎉 a comment\nconst a = JSON.parse(t) as T; /* 🚀 */ const b = 1;\n';
  assert.deepEqual(patterns(text), ['2 json-parse-as']);
  assert.deepEqual(patterns("const s = '🎉'; // JSON.parse(t) as T\n"), []);
});

test('finds a json read type in any option position and spelling', () => {
  for (const text of [
    "const a = await kv.get(key, { cacheTtl: 60, type: 'json' });",
    "const a = await kv.get(key, { 'type': 'json' });",
    'const a = await kv.get(key, { "type": "json", cacheTtl: 1 });',
    "const a = await kv.get(key, 'json' as const);",
    "const a = await kv.get(key, ('json'));",
    'const a = await kv.get(key, `json`);',
    "const a = await kv.getWithMetadata(key, { cacheTtl: 5, ['type']: 'json' as const });",
  ]) {
    assert.deepEqual(patterns(text), ['1 kv-get-json'], text);
  }
  assert.deepEqual(patterns("const a = await kv.get(key, { type: 'text', note: 'json' });"), []);
});

test('regular-expression literals never start a false string or comment', () => {
  assert.deepEqual(patterns('const quote = /["\']/; const a = JSON.parse(t) as T;\nconst b = 1;'), [
    '1 json-parse-as',
  ]);
  assert.deepEqual(patterns("const slashes = /\\/\\//g; const a = await kv.get(k, 'json');"), [
    '1 kv-get-json',
  ]);
  assert.deepEqual(patterns("const q = /'/; const x = 1;\nconst a = (await r.json()) as Body;"), [
    '2 json-await-as',
  ]);
});

test('flags a cast written as a type assertion, and allows as const and as unknown', () => {
  assert.deepEqual(patterns('const a = <Body>JSON.parse(t);', 'x.ts'), ['1 json-parse-as']);
  assert.deepEqual(patterns('const a = JSON.parse(t) as unknown;'), []);
});

test('allows reads as unknown and validated forms', () => {
  for (const text of [
    "const a = await kv.get(key, 'text');",
    "const a = await kv.get<string>(key, 'text');",
    'const a = map.get<Thing>(key);',
    'const a = await response.json<unknown>();',
    'const a = await c.req.json<unknown>();',
    "app.get('/export', async (c) => c.json({ format: 'json' }));",
    "const a = await kv.getWithMetadata(key, 'text');",
    'const a = (await response.json()) as unknown;',
    'const a = JSON.parse(text) as unknown;',
    'const a = JSON.parse(text);',
    'const a = Schema.parse(JSON.parse(text));',
    'const ok = (await response.json()).success === true;',
  ]) {
    assert.deepEqual(patterns(text), [], text);
  }
});

test('ignores comments, but not code next to them, and skips strings correctly', () => {
  assert.deepEqual(patterns("// const a = await kv.get<Route>(key, 'json');"), []);
  assert.deepEqual(
    patterns('/* (await r.json()) as Body\n JSON.parse(x) as Y */ const b = 1;'),
    [],
  );
  assert.deepEqual(
    patterns("const url = 'https://app.example//y'; const a = JSON.parse(t) as T;"),
    ['1 json-parse-as'],
  );
});

test('honours the escape hatch on the same line or the line before, with a reason', () => {
  assert.deepEqual(
    patterns('// boundary-ok: SDK validated the args\nconst a = JSON.parse(t) as T;'),
    [],
  );
  assert.deepEqual(patterns('const a = JSON.parse(t) as T; // boundary-ok: vetted'), []);
  // No reason, or too far away: still a finding
  assert.deepEqual(patterns('// boundary-ok:\nconst a = JSON.parse(t) as T;'), ['2 json-parse-as']);
  assert.deepEqual(patterns('// boundary-ok: x\n\nconst a = JSON.parse(t) as T;'), [
    '3 json-parse-as',
  ]);
});

test('scans production sources only: never tests, declarations or generated code', () => {
  for (const path of [
    'src/kv/routes.ts',
    'admin/src/pages/routes.tsx',
    'shared/src/qr.ts',
    'mcp/src/index.ts',
  ]) {
    assert.equal(isProductionSource(path), true, path);
  }
  for (const path of [
    'src/kv/routes.test.ts',
    'admin/src/pages/routes.acceptance.test.tsx',
    'shared/src/qr.spec.ts',
    'src/__tests__/x.ts',
    'src/test/helper.ts',
    'src/generated/changelog-text.ts',
    'src/types.d.ts',
    'src/readme.md',
  ]) {
    assert.equal(isProductionSource(path), false, path);
  }
});

test('finds a json read type before or after a spread, and in a computed key', () => {
  for (const text of [
    "const a = await kv.get(key, { ...options, type: 'json' });",
    "const a = await kv.get(key, { type: 'json', ...options });",
    'const a = await kv.get(key, { ...a, cacheTtl: 5, ...b, ["type"]: `json` });',
    "const a = await kv.getWithMetadata(key, { metadata: true, 'type': 'json' as const });",
  ]) {
    assert.deepEqual(patterns(text), ['1 kv-get-json'], text);
  }
  assert.deepEqual(patterns("const a = await kv.get(key, { ...options, type: 'text' });"), []);
});

test('the escape hatch is a real comment, never text that looks like one', () => {
  // In a string literal on the same line, or the line before
  assert.deepEqual(patterns('const s = "// boundary-ok: x"; const a = JSON.parse(t) as T;'), [
    '1 json-parse-as',
  ]);
  assert.deepEqual(
    patterns("const s = '// boundary-ok: not a comment';\nconst a = JSON.parse(t) as T;"),
    ['2 json-parse-as'],
  );
  // In a template literal spanning the line before
  assert.deepEqual(
    patterns('const s = `\n// boundary-ok: not a comment\n`;\nconst a = JSON.parse(t) as T;'),
    ['4 json-parse-as'],
  );
  // In a regular-expression literal
  assert.deepEqual(patterns('const r = /\\/\\/ boundary-ok: x/; const a = JSON.parse(t) as T;'), [
    '1 json-parse-as',
  ]);
  // A block comment is not the marker
  assert.deepEqual(patterns('/* boundary-ok: vetted */\nconst a = JSON.parse(t) as T;'), [
    '2 json-parse-as',
  ]);
  // A comment on another statement does not carry over
  assert.deepEqual(
    patterns('// boundary-ok: vetted\nconst b = 1;\nconst a = JSON.parse(t) as T;'),
    ['3 json-parse-as'],
  );
  // The line just before the read counts, whatever statement it ends
  assert.deepEqual(
    patterns('const b = 1; // boundary-ok: vetted\nconst a = JSON.parse(t) as T;'),
    [],
  );
});

test('the escape hatch is on the line of the read or the line before, nothing else', () => {
  // On the line before the read, or on the read's line, after any token
  assert.deepEqual(
    patterns('const a = f(\n  1,\n  // boundary-ok: vetted\n  JSON.parse(t) as T,\n);'),
    [],
  );
  assert.deepEqual(
    patterns('const a = f(\n  JSON.parse(t) as T, // boundary-ok: vetted\n  2,\n);'),
    [],
  );
  assert.deepEqual(patterns('const a = // boundary-ok: vetted\n  JSON.parse(t) as T;'), []);
  assert.deepEqual(
    patterns('switch (k) {\n  case 1: // boundary-ok: vetted\n    return JSON.parse(t) as T;\n}'),
    [],
  );
  assert.deepEqual(patterns('x = f(JSON.parse(t) as T); // boundary-ok: vetted'), []);
  // A comment above a multi-line statement covers only the line below it
  assert.deepEqual(
    patterns(
      '// boundary-ok: vetted\nconst a = {\n  b: JSON.parse(t) as T,\n  c: JSON.parse(u) as U,\n};',
    ),
    ['3 json-parse-as', '4 json-parse-as'],
  );
  // A concise arrow body on the following line is not covered from above
  assert.deepEqual(patterns('// boundary-ok: vetted\nconst f = () =>\n  JSON.parse(t) as T;'), [
    '3 json-parse-as',
  ]);
  // A marker two lines above, even in a run of comments, does not count
  assert.deepEqual(
    patterns('// boundary-ok: vetted\n// another comment\nconst a = JSON.parse(t) as T;'),
    ['3 json-parse-as'],
  );
  // A comment leading a sibling argument does not count
  assert.deepEqual(
    patterns('const a = f(\n  // boundary-ok: vetted\n  1,\n  JSON.parse(t) as T,\n);'),
    ['4 json-parse-as'],
  );
});

test('flags an untyped JSON read initialising an annotated binding', () => {
  assert.deepEqual(patterns('const a: Body = await r.json();'), ['1 json-annotated']);
  assert.deepEqual(patterns('let a: Body = await r.json();'), ['1 json-annotated']);
  assert.deepEqual(patterns('var a: Body | null = (await r.json());'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a: Body = await r.json().catch(() => null);'), [
    '1 json-annotated',
  ]);
  assert.deepEqual(patterns('const { x }: Body = await r.json();'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a: any = await r.json();'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a: Body = await c.req.json();'), [
    '1 json-annotated',
    '1 req-json-untyped',
  ]);
  assert.deepEqual(patterns('class C {\n  a: Body = r.json();\n}'), ['2 json-annotated']);
  assert.deepEqual(patterns('function f(a: Body = r.json()) {}'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a: Body = JSON.parse(text);'), ['1 json-parse-annotated']);
  for (const text of [
    'const a: unknown = await r.json();',
    'const a: unknown = JSON.parse(text);',
    'const a = await r.json();',
    'const a: Body = await r.json<unknown>();',
    'const a: Body = Schema.parse(await r.json());',
    'const a: boolean = (await r.json()).ok === true;',
    'function f(a: Body = defaults()) {}',
  ]) {
    assert.deepEqual(patterns(text), [], text);
  }
});

test('a .json() call with arguments is a response helper, not a read', () => {
  for (const text of [
    'const res: Response = c.json(body, 200);',
    'const res: Response = c.json(body);',
    'let res: Response;\nres = c.json({ ok: true }, 201);',
  ]) {
    assert.deepEqual(patterns(text), [], text);
  }
});

test('a union with unknown in it counts as unknown', () => {
  for (const text of [
    'const a: unknown | null = await r.json();',
    'const a: undefined | unknown = JSON.parse(t);',
    'const a: (unknown | null) | undefined = await r.json();',
    'const a: null | (unknown) = await r.json();',
    'const a = JSON.parse(t) as unknown | null;',
    'const a = (await r.json()) as unknown | undefined;',
    'let a: unknown | null;\na = await r.json();',
  ]) {
    assert.deepEqual(patterns(text), [], text);
  }
  // TypeScript collapses `unknown | T` to `unknown`: nothing is asserted
  for (const text of [
    'const a: unknown | string = await r.json();',
    'const a: Body | (unknown | null) = JSON.parse(t);',
    'const a = JSON.parse(t) as Body | unknown;',
    'const a = await r.json<string | unknown>();',
  ]) {
    assert.deepEqual(patterns(text), [], text);
  }
  assert.deepEqual(patterns('const a = JSON.parse(t) as null | Body;'), ['1 json-parse-as']);
});

test('a union with any in it is any, not unknown, however it is nested', () => {
  assert.deepEqual(patterns('const a: unknown | any = await r.json();'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a = JSON.parse(t) as (null | (any | unknown));'), [
    '1 json-parse-as',
  ]);
  assert.deepEqual(patterns('const a = await r.json<unknown | (any)>();'), ['1 json-generic']);
  assert.deepEqual(patterns('const a: any = await r.json();'), ['1 json-annotated']);
});

test('an annotated binding is looked through ??, ||, && and both branches of a conditional', () => {
  assert.deepEqual(patterns('const a: Body = cached ?? (await r.json());'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a: Body = (await r.json()) || fallback;'), ['1 json-annotated']);
  assert.deepEqual(patterns('const a: Body = ok && JSON.parse(t);'), ['1 json-parse-annotated']);
  assert.deepEqual(patterns('const a: Body = ok ? JSON.parse(t) : await r.json();'), [
    '1 json-annotated',
    '1 json-parse-annotated',
  ]);
  assert.deepEqual(patterns('let a: Body;\na = ok ? fallback : (await r.json())!;'), [
    '2 json-annotated',
  ]);
  assert.deepEqual(patterns('const a: unknown = cached ?? (await r.json());'), []);
});

test('a declaration in a switch is found in its whole case block', () => {
  const text = [
    'switch (k) {',
    '  case 1:',
    '    let a: Body;',
    '    break;',
    '  case 2:',
    '    a = await r.json();',
    '    break;',
    '}',
  ].join('\n');
  assert.deepEqual(patterns(text), ['6 json-annotated']);
});

test('a chain of assertions is flagged when any assertion names a type', () => {
  assert.deepEqual(patterns('const a = (await r.json()) as unknown as Body;'), ['1 json-await-as']);
  assert.deepEqual(patterns('const a = JSON.parse(s) as unknown as Body;'), ['1 json-parse-as']);
  assert.deepEqual(patterns('const a = <Body>(<unknown>JSON.parse(s));'), ['1 json-parse-as']);
  // One finding for one chain, however long
  assert.deepEqual(patterns('const a = (r.json() as Body) as Other;'), ['1 json-await-as']);
  assert.deepEqual(patterns('const a = JSON.parse(s) as unknown;'), []);
  assert.deepEqual(patterns('const a = JSON.parse(s) as unknown as const;'), []);
});

test('a KV read asking for json through an assertion is flagged', () => {
  assert.deepEqual(patterns('const a = await kv.get<Body>(k, "json" as "json");'), [
    '1 kv-get-json',
  ]);
  assert.deepEqual(patterns('const a = await kv.get(k, <const>"json");'), ['1 kv-get-json']);
  assert.deepEqual(patterns('const a = await kv.get(k, { type: "json" as "json" });'), [
    '1 kv-get-json',
  ]);
});

test('a marker vets only its own read: never one inside a callback or argument of the receiver', () => {
  // The inner marker documents the callback, not the outer read
  const callback = [
    'const a = await wrap(async () => {',
    '  // boundary-ok: inner callback',
    '  return 1;',
    '}).json<Body>();',
  ].join('\n');
  assert.deepEqual(patterns(callback), ['4 json-generic']);
  const argument = [
    'const a = await fetch(url, {',
    '  // boundary-ok: about the options',
    '}).json<Body>();',
  ].join('\n');
  assert.deepEqual(patterns(argument), ['3 json-generic']);
  // The legitimate multi-line chain: the marker on the line before `.json`
  const chain = ['const a = await response', '  // boundary-ok: vetted', '  .json<Body>();'].join(
    '\n',
  );
  assert.deepEqual(patterns(chain), []);
  // A marker on the read's own token line still vets it
  assert.deepEqual(
    patterns('const a = await wrap(() => 1).json<Body>(); // boundary-ok: vetted'),
    [],
  );
});

test('flags a read assigned, plainly or logically, to an annotated binding declared earlier', () => {
  assert.deepEqual(patterns('let a: Body;\na = await r.json();'), ['2 json-annotated']);
  assert.deepEqual(patterns('let a: Body | null = null;\na ??= await r.json();'), [
    '2 json-annotated',
  ]);
  assert.deepEqual(patterns('let a: Body | undefined;\na ||= JSON.parse(t);'), [
    '2 json-parse-annotated',
  ]);
  assert.deepEqual(patterns('let a: Body | null = x;\na &&= await r.json();'), [
    '2 json-annotated',
  ]);
  assert.deepEqual(patterns('let a: Body;\ntry {\n  a = await r.json();\n} catch {}'), [
    '3 json-annotated',
  ]);
  assert.deepEqual(patterns('function f(a: Body) {\n  a = await r.json();\n}'), [
    '2 json-annotated',
  ]);
  for (const text of [
    'let a: unknown;\na = await r.json();',
    'let a;\na = await r.json();',
    'b = await r.json();',
    'let a: Body;\na = parse(t);',
    'let a: number;\na += JSON.parse(t);',
  ]) {
    assert.deepEqual(patterns(text), [], text);
  }
});

test('reports file:line pattern across a tree and excludes test files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boundary-gate-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src', 'kv'), { recursive: true });
  await writeFile(join(root, 'src', 'kv', 'a.ts'), "x\nconst r = await kv.get<R>(k, 'json');\n");
  await writeFile(join(root, 'src', 'kv', 'a.test.ts'), 'const r = JSON.parse(t) as R;\n');
  await writeFile(join(root, 'src', 'ok.ts'), 'const r: unknown = JSON.parse(t);\n');
  assert.deepEqual(checkBoundaryReads(root, ['src']), ['src/kv/a.ts:2 kv-get-json']);
});

test('the repository has no unvalidated boundary reads', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(checkBoundaryReads(repoRoot), []);
});
