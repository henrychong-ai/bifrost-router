import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  contentFindings,
  createIdentifierMatcher,
  IDENTIFIER_SALT,
  identifierDigest,
  PRIVATE_IDENTIFIER_DIGESTS,
  publicCandidateFiles,
  sanitizationFindings,
  singleLabelHostFindings,
  wranglerIdentifierFindings,
} from './check-public-sanitization.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCANNER = 'scripts/check-public-sanitization.mjs';
const SCANNER_TEST = 'scripts/check-public-sanitization.test.mjs';

// The gate scans this file too, in its written, escape-blanked and decoded
// forms, so every value it must reject is assembled at runtime rather than
// written out. All of them are synthetic.
const glue = (...parts) => parts.join('');
const BS = '\\';
const MAC_HOME = glue('/', 'Users/someone/projects/x');
const TAILNET_HOST = glue('box.some-tailnet', '.ts', '.net');
const PRIVATE_EMAIL = glue('ops', '@', 'corp-mail.test');
const NUMBERED_HOST = glue('vps', '-7');
const SECRET_REFERENCE = glue('op:/', '/Personal/Cloudflare/token');
const SINGLE_LABEL = glue('https:/', '/app');
const SINGLE_LABEL_ENCODED = glue('https%3A%2F', '%2Fapp');

const TEMP_DIRECTORY = mkdtempSync(join(tmpdir(), 'bifrost-public-scan-'));
after(() => rmSync(TEMP_DIRECTORY, { recursive: true, force: true }));

let tempCount = 0;
function writeTemp(text) {
  tempCount += 1;
  const file = join(TEMP_DIRECTORY, `case-${tempCount}.txt`);
  writeFileSync(file, text);
  return file;
}

const HOME = 'line 1: home-directory path';

test('rejects private content and accepts public placeholders', () => {
  const safe = writeTemp(
    [
      'bifrost.example.com your-cloudflare-account-id op://Your-Vault/Cloudflare/API-Token',
      'https://bifrost.your-tailnet.ts.net user@example.com a@mail.example.org x@app.example',
      '12345+bot@users.noreply.github.com "packageManager": "pnpm@10.33.0"',
      'GET /api/users/42/roles assets.fusang.co',
    ].join('\n'),
  );
  const unsafe = writeTemp(
    [MAC_HOME, TAILNET_HOST, PRIVATE_EMAIL, NUMBERED_HOST, SECRET_REFERENCE, SINGLE_LABEL].join(
      '\n',
    ),
  );
  assert.deepEqual(sanitizationFindings([safe]), []);
  assert.deepEqual(
    sanitizationFindings([unsafe]).map(finding => finding.slice(unsafe.length + 2)),
    [
      'line 1: home-directory path',
      'line 2: Tailscale MagicDNS host',
      'line 3: email address outside the example domains',
      'line 4: numbered private host',
      'line 5: non-placeholder 1Password reference',
      'line 6: single-label https host (use an RFC 2606 name)',
    ],
  );
});

test('flags a macOS Users path anywhere, with a capital U only', () => {
  for (const path of [
    MAC_HOME,
    glue('file://', MAC_HOME),
    glue('/System/Volumes/Data', MAC_HOME),
    glue('/Volumes/Backup', MAC_HOME),
    glue('/mnt/c', MAC_HOME),
    glue('"../..', MAC_HOME, '/src/a.ts"'),
    glue('"see', BS, 'n', MAC_HOME, '"'),
    glue('next=%2F', 'Users%2Fsomeone%2Fx'),
  ]) {
    assert.deepEqual(contentFindings(path), [HOME], path);
  }
  for (const path of [
    glue('/', 'Users/Shared/cache/x'),
    glue('/', 'users/me/settings'),
    glue('"/', 'users/someone/x"'),
    'GET /api/users/42/roles',
    glue('/', 'USERS/SOMEONE/x'),
    glue('/', 'Users/<name>/x'),
  ]) {
    assert.deepEqual(contentFindings(path), [], path);
  }
});

test('flags a Windows Users path with either slash', () => {
  for (const path of [
    glue('C:', BS, 'Users', BS, 'someone', BS, 'x'),
    glue('c:', BS, 'users', BS, 'someone', BS),
    glue('D:/', 'Users/someone/x'),
    glue('C:', BS, 'Users/someone/x'),
    glue('"C:', BS, BS, 'Users', BS, BS, 'someone', BS, BS, 'x"'),
  ]) {
    assert.deepEqual(contentFindings(path), [HOME], path);
  }
  for (const path of [
    glue('C:', BS, 'Program Files', BS, 'x'),
    glue('C:', BS, 'Users', BS, '<name>', BS),
    glue('xC:', BS, 'notusers', BS, 'someone', BS),
  ]) {
    assert.deepEqual(contentFindings(path), [], path);
  }
});

test('flags a Linux home path except the container and CI users', () => {
  for (const path of [
    glue('/', 'home/someone/.config'),
    glue('/var/', 'home/someone/x'),
    glue('cd /', 'home/someone/'),
  ]) {
    assert.deepEqual(contentFindings(path), [HOME], path);
  }
  for (const path of [
    glue('/', 'home/node/app'),
    glue('/', 'home/runner/work/repo'),
    glue('/var/', 'home/runner/x'),
    glue('/srv/site/', 'home/someone/x'),
    glue('/', 'home/<user>/x'),
  ]) {
    assert.deepEqual(contentFindings(path), [], path);
  }
});

test('flags a home directory with no trailing separator', () => {
  for (const text of [
    glue('{"home":"/', 'Users/someone"}'),
    glue('/', 'Users/someone'),
    glue('export HOME="/', 'home/someone"'),
    glue('/', 'home/someone and more'),
    glue('/var/', 'home/someone'),
    glue('C:', BS, 'Users', BS, 'someone'),
    glue('C:', BS, 'Users', BS, 'Jane Doe', BS, 'project'),
    glue('"C:', BS, 'Users', BS, 'Jane Doe"'),
    glue('D:/', 'Users/Jane Doe/x'),
  ]) {
    assert.deepEqual(contentFindings(text), [HOME], text);
  }
  for (const text of [
    glue('/', 'Users/Shared'),
    glue('"/', 'Users/Shared"'),
    glue('/', 'home/node'),
    glue('export HOME=/', 'home/runner'),
    glue('/', 'users/me'),
    glue('/', 'Users/<you>'),
    glue('/', 'home/<user>'),
    glue('C:', BS, 'Users', BS, '<you>'),
    glue('/', 'Users/'),
    glue('C:', BS, 'Users', BS),
    glue('C:', BS, 'Users', BS, '  '),
  ]) {
    assert.deepEqual(contentFindings(text), [], text);
  }
});

test('flags any MagicDNS host except a your- placeholder tailnet', () => {
  assert.deepEqual(contentFindings(TAILNET_HOST), ['line 1: Tailscale MagicDNS host']);
  assert.deepEqual(contentFindings(TAILNET_HOST.toUpperCase()), [
    'line 1: Tailscale MagicDNS host',
  ]);
  assert.deepEqual(contentFindings(glue('*.some-tailnet', '.ts', '.net')), [
    'line 1: Tailscale MagicDNS host',
  ]);
  assert.deepEqual(contentFindings('https://bifrost.your-tailnet.ts.net/'), []);
  assert.deepEqual(contentFindings(glue('ts', '.net', ' alone')), []);
});

test('flags an email address outside the example and no-reply domains', () => {
  for (const text of [
    'user@example.com',
    'user@example.org',
    'user@example.net',
    'ops@user1.example.com',
    'idp@login.example',
    '1+bot@users.noreply.github.com',
    // Version pins: the top-level label is not alphabetic.
    'drizzle-orm@0.45.3 pnpm@10.33.0',
    // scp-style and ssh git remotes.
    glue('git', '@', 'github.com:org/repo.git'),
    glue('ssh://git', '@', 'github.com/org/repo'),
    // Resolution-suffixed asset names.
    glue('icon', '@', '2x.png'),
    glue('logo', '@', '1.5x.webp'),
  ]) {
    assert.deepEqual(contentFindings(text), [], text);
  }
  for (const text of [
    PRIVATE_EMAIL,
    PRIVATE_EMAIL.toUpperCase(),
    glue('mailto:', PRIVATE_EMAIL),
    glue('git', '@', 'corp-mail.test'),
    glue('ops', '@', 'example.com.corp.test'),
    glue('ops', '@', 'notexample.com'),
    glue('ops%40', 'corp-mail.test'),
  ]) {
    assert.deepEqual(
      contentFindings(text),
      ['line 1: email address outside the example domains'],
      text,
    );
  }
});

test('keeps the numbered-host and 1Password rules, after escapes too', () => {
  for (const text of [
    NUMBERED_HOST,
    glue('C:', BS, 'servers', BS, NUMBERED_HOST, BS, 'share'),
    glue(BS, BS, NUMBERED_HOST, BS, 'c$'),
    glue('"a', BS, 'n', NUMBERED_HOST, '"'),
  ]) {
    assert.deepEqual(contentFindings(text), ['line 1: numbered private host'], text);
  }
  assert.deepEqual(contentFindings(SECRET_REFERENCE), [
    'line 1: non-placeholder 1Password reference',
  ]);
  assert.deepEqual(contentFindings('op://your-vault/x op://your-1password/y'), []);
});

test('hashed identifiers match by token, dot suffix, hyphen part and case', () => {
  const salt = 'test-salt';
  const digests = new Set([
    identifierDigest(salt, 'secret-host.example-private'),
    identifierDigest(salt, 'hidden-name'),
    identifierDigest(salt, 'beta-host'),
  ]);
  const matches = createIdentifierMatcher({ salt, digests });

  for (const text of [
    // Whole token, in a URL, an email address and a path.
    'see secret-host.example-private here',
    'ops@secret-host.example-private',
    '/srv/hidden-name/data',
    // Dot suffix: the host as a subdomain of something longer.
    'https://api.v2.secret-host.example-private/v1',
    // Hyphen parts: inside a longer hyphenated name, either side.
    'hidden-name-site',
    'my-hidden-name',
    'my-hidden-name-site.example',
    // Case.
    'HIDDEN-NAME',
    'Secret-Host.Example-Private',
  ]) {
    assert.equal(matches(text), true, text);
  }

  // Only whole parts match: a glued form, a partial word or a host prefix is
  // intentionally not matched.
  for (const text of [
    'hidden-names',
    'xhidden-name',
    'hidden_name',
    'hidden name',
    'secret-host.example',
    'example-private',
    'hidden',
  ]) {
    assert.equal(matches(text), false, text);
  }

  // A window longer than maxParts is not looked at.
  assert.equal(createIdentifierMatcher({ salt, digests, maxParts: 1 })('hidden-name'), false);
  // The default matcher uses the shipped set, which holds no synthetic name.
  assert.deepEqual(contentFindings('hidden-name secret-host.example-private beta-host'), []);
});

test('escapes neither eat a name nor hide one', () => {
  const salt = 'test-salt';
  const matcher = createIdentifierMatcher({
    salt,
    digests: new Set([identifierDigest(salt, 'hidden-name'), identifierDigest(salt, 'beta-host')]),
  });
  const found = ['line 1: hashed private identifier'];
  for (const text of [
    // An escape-like sequence just before the name: the written form keeps it.
    glue('C:', BS, 'code', BS, 'hidden-name', BS),
    'progress 100%beta-host done',
    // An escape glued straight onto the name: the blanked form keeps it.
    'next=x%2Fhidden-name%2Fx',
    glue('"line one', BS, 'nhidden-name"'),
    glue('"', BS, 'u002fsrv', BS, 'u002fhidden-name"'),
    // An escaped delimiter inside the name: the decoded form restores it.
    'hidden%2Dname',
    'HIDDEN%2dNAME',
    glue('hidden', BS, 'u002dname'),
    glue('hidden', BS, 'x2dname'),
    glue('beta', BS, 'u002Dhost'),
    // An encoded or Markdown-escaped hyphen inside a Windows or POSIX path:
    // the partly decoded form keeps the backslash separators.
    glue('C:', BS, 'code', BS, 'hidden%2Dname', BS, 'file'),
    glue('C:', BS, 'code', BS, 'hidden', BS, '-name', BS, 'file'),
    'C:/code/hidden%2Dname/file',
    glue('C:/code/hidden', BS, '-name/file'),
  ]) {
    assert.deepEqual(contentFindings(text, matcher), found, text);
  }
  // Lines are reported once each, in order.
  assert.deepEqual(contentFindings('a\nb\nhidden-name\nhidden-name hidden-name', matcher), [
    'line 3: hashed private identifier',
    'line 4: hashed private identifier',
  ]);
});

test('findings never echo the matched value', () => {
  const sensitive = [
    'zqsecretuser',
    'zqsecretnet',
    'zqsecretmail',
    'zqsecretvault',
    'zqsecretapp',
    'zqsecretid',
  ];
  const file = writeTemp(
    [
      glue('/', 'Users/zqsecretuser/x'),
      glue('C:', BS, 'Users', BS, 'zqsecretuser', BS),
      glue('/', 'home/zqsecretuser/x'),
      glue('h.zqsecretnet', '.ts', '.net'),
      glue('ops', '@', 'zqsecretmail.test'),
      glue('op:/', '/zqsecretvault/item'),
      glue('https:/', '/zqsecretapp/x'),
      glue('https%3A%2F', '%2Fzqsecretapp%2F'),
      NUMBERED_HOST,
    ].join('\n'),
  );
  const findings = [
    ...sanitizationFindings([file]),
    ...wranglerIdentifierFindings('id = "zqsecretid0123"\ndatabase_id = "your-d1-id"'),
  ];
  assert.equal(findings.length, 10);
  for (const finding of findings) {
    for (const value of [...sensitive, NUMBERED_HOST]) {
      assert.ok(!finding.toLowerCase().includes(value), `${finding} echoes a value`);
    }
  }
});

test('stays linear on adversarial input', () => {
  const inputs = [
    'ab.'.repeat(70_000),
    'a'.repeat(200_000),
    'a@b.'.repeat(50_000),
    'x.ts.'.repeat(40_000),
    glue('/', 'Users').repeat(30_000),
    glue('/', 'home').repeat(40_000),
    'a-'.repeat(100_000),
    '%2'.repeat(70_000),
    glue(BS, 'u00').repeat(40_000),
    'https'.repeat(40_000),
  ];
  const started = performance.now();
  for (const input of inputs) contentFindings(input);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
});

test('ships only salted SHA-256 digests', () => {
  assert.equal(PRIVATE_IDENTIFIER_DIGESTS.size, 22);
  for (const digest of PRIVATE_IDENTIFIER_DIGESTS) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    identifierDigest('s', 'value'),
    createHash('sha256').update('s:value').digest('hex'),
  );
  // The documented one-liner uses the same salt as the matcher.
  const source = readFileSync(new URL('./check-public-sanitization.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes(`update('${IDENTIFIER_SALT}:' + process.argv[1].toLowerCase())`));
});

test('the scanner and this test pass their own scan', () => {
  assert.deepEqual(sanitizationFindings([SCANNER, SCANNER_TEST], REPO_ROOT), []);
});

test('rejects real-looking Wrangler identifiers', () => {
  assert.deepEqual(
    wranglerIdentifierFindings('id = "your-kv-namespace-id"\ndatabase_id = "your-d1-id"'),
    [],
  );
  assert.deepEqual(wranglerIdentifierFindings('\nid = "0123456789abcdef0123456789abcdef"'), [
    'wrangler.toml: line 2: non-placeholder id',
  ]);
});

test('scans tracked and untracked release candidates', () => {
  const candidates = publicCandidateFiles(REPO_ROOT);
  assert.ok(candidates.includes(SCANNER_TEST));
  assert.ok(candidates.includes('test/performance/analytics-performance.test.ts'));
});

test('flags a single-label https host and accepts an RFC 2606 name', () => {
  // A single-label host is reserved by nothing: it reads as an internal
  // hostname and may one day resolve for somebody.
  assert.deepEqual(singleLabelHostFindings(glue('see ', SINGLE_LABEL, '/cb?token=x')), [
    SINGLE_LABEL,
  ]);
  assert.deepEqual(singleLabelHostFindings('see https://a.example/b'), []);
  assert.deepEqual(singleLabelHostFindings('http://example.com/x'), []);
  // The percent-encoded form a nested-URL example carries.
  assert.deepEqual(singleLabelHostFindings(glue('?next=', SINGLE_LABEL_ENCODED, '%3Ftoken%3Dx')), [
    SINGLE_LABEL_ENCODED,
  ]);
  assert.deepEqual(singleLabelHostFindings('?next=https%3A%2F%2Fapp.example%3Ftoken%3Dx'), []);
  // localhost is reserved and means what it says.
  assert.deepEqual(singleLabelHostFindings('https://localhost:8787/health'), []);
  // Reported once however many times it appears.
  assert.deepEqual(singleLabelHostFindings(glue(SINGLE_LABEL, '/a ', SINGLE_LABEL, '/b')), [
    SINGLE_LABEL,
  ]);
});
