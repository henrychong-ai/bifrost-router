import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_IDENTIFIER_LINES,
  CheckSettingError,
  CommitRangeError,
  ciRevListArgs,
  commitEmailsChecked,
  commitFindings,
  commitRangeFindings,
  contentFindings,
  hasCloudIdentifier,
  identityEmailAllowed,
  isPlaceholderIdentifier,
  loadExtraTerms,
  loadTermsFile,
  PINNED_BINARY_FILES,
  parseExtraTerms,
  parseTermsFile,
  prePushRevListArgs,
  publicCandidateFiles,
  sanitizationFindings,
  singleLabelHostFindings,
  TermsFileError,
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
// A random-looking 32-hex value and UUID, split so this file holds neither.
const CLOUD_HEX = glue('a1b2c3d4', 'e5f60718', '293a4b5c', '6d7e8f90');
const CLOUD_UUID = glue('3f2a9c1e', '-7b4d-4e8a-9c2f-', '1a2b3c4d5e6f');
const GITHUB_NOREPLY = glue('noreply', '@', 'github.com');
const GITHUB_SUPPORT = glue('support', '@', 'github.com');

const TEMP_DIRECTORY = mkdtempSync(join(tmpdir(), 'bifrost-public-scan-'));
after(() => rmSync(TEMP_DIRECTORY, { recursive: true, force: true }));

/** Scan one temp file by its name, so the temp directory's path never counts. */
function scanTemp(file, options) {
  return sanitizationFindings([basename(file)], dirname(file), options);
}

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
      'GET /api/users/42/roles',
    ].join('\n'),
  );
  const unsafe = writeTemp(
    [MAC_HOME, TAILNET_HOST, PRIVATE_EMAIL, NUMBERED_HOST, SECRET_REFERENCE, SINGLE_LABEL].join(
      '\n',
    ),
  );
  assert.deepEqual(scanTemp(safe), []);
  assert.deepEqual(
    scanTemp(unsafe).map(finding => finding.slice(basename(unsafe).length + 2)),
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

// Extra terms: a clone's own private names, never committed. Matched as a
// case-insensitive substring of any of a line's four forms; `re:` lines are
// regular expressions.
const TERMS = parseExtraTerms(
  [
    '# a comment',
    '',
    '  Hidden-Name  ',
    'beta-host',
    glue('re:', BS, 'bZQ-', BS, 'd+', BS, 'b'),
  ].join('\n'),
);
const TERM_HIDDEN = 'line 1: extra term (terms file line 3)';
const TERM_BETA = 'line 1: extra term (terms file line 4)';
const TERM_TICKET = 'line 1: extra term (terms file line 5)';

test('extra terms match as case-insensitive substrings and regular expressions', () => {
  assert.equal(TERMS.length, 3);
  for (const [text, finding] of [
    ['see hidden-name here', TERM_HIDDEN],
    ['HIDDEN-NAME', TERM_HIDDEN],
    ['xhidden-names', TERM_HIDDEN],
    ['https://api.beta-host.example/v1', TERM_BETA],
    ['fixes zq-42 today', TERM_TICKET],
    ['ZQ-7', TERM_TICKET],
  ]) {
    assert.deepEqual(contentFindings(text, { extraTerms: TERMS }), [finding], text);
  }
  for (const text of ['hidden_name', 'hidden name', 'beta host', 'zq-x', 'xzq-42']) {
    assert.deepEqual(contentFindings(text, { extraTerms: TERMS }), [], text);
  }
  // Without terms, only the generic rules run
  assert.deepEqual(contentFindings('hidden-name beta-host zq-42'), []);
});

test('escapes neither eat a term nor hide one', () => {
  for (const [text, finding] of [
    // An escape-like sequence just before the name: the written form keeps it.
    [glue('C:', BS, 'code', BS, 'hidden-name', BS), TERM_HIDDEN],
    ['progress 100%beta-host done', TERM_BETA],
    // An escape glued straight onto the name.
    ['next=x%2Fhidden-name%2Fx', TERM_HIDDEN],
    [glue('"line one', BS, 'nhidden-name"'), TERM_HIDDEN],
    [glue('"', BS, 'u002fsrv', BS, 'u002fhidden-name"'), TERM_HIDDEN],
    // An escaped delimiter inside the name: the decoded form restores it.
    ['hidden%2Dname', TERM_HIDDEN],
    ['HIDDEN%2dNAME', TERM_HIDDEN],
    [glue('hidden', BS, 'u002dname'), TERM_HIDDEN],
    [glue('hidden', BS, 'x2dname'), TERM_HIDDEN],
    [glue('beta', BS, 'u002Dhost'), TERM_BETA],
    // An encoded or Markdown-escaped hyphen inside a Windows or POSIX path.
    [glue('C:', BS, 'code', BS, 'hidden%2Dname', BS, 'file'), TERM_HIDDEN],
    [glue('C:', BS, 'code', BS, 'hidden', BS, '-name', BS, 'file'), TERM_HIDDEN],
    ['C:/code/hidden%2Dname/file', TERM_HIDDEN],
    [glue('C:/code/hidden', BS, '-name/file'), TERM_HIDDEN],
  ]) {
    assert.deepEqual(contentFindings(text, { extraTerms: TERMS }), [finding], text);
  }
  // Lines are reported once each per term, in order.
  assert.deepEqual(
    contentFindings('a\nb\nhidden-name\nhidden-name hidden-name', { extraTerms: TERMS }),
    ['line 3: extra term (terms file line 3)', 'line 4: extra term (terms file line 3)'],
  );
});

test('a bad terms entry is refused by its line, never echoing it', () => {
  for (const text of ['ok\nre:', glue('ok\n\nre:(unclosed', '-zqterm')]) {
    assert.throws(
      () => parseExtraTerms(text),
      error =>
        error instanceof TermsFileError &&
        /line \d+/.test(error.message) &&
        !error.message.includes('zqterm'),
    );
  }
  assert.deepEqual(parseExtraTerms('# only comments\n\n   \n'), []);
  // CRLF line ends are trimmed
  assert.deepEqual(
    contentFindings('see hidden-name', { extraTerms: parseExtraTerms('hidden-name\r\n') }),
    ['line 1: extra term (terms file line 1)'],
  );
});

test('findings never echo the matched value', () => {
  const sensitive = [
    'zqsecretuser',
    'zqsecretnet',
    'zqsecretmail',
    'zqsecretvault',
    'zqsecretapp',
    'zqsecretid',
    'zqsecretterm',
    CLOUD_HEX,
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
      glue('account_id = "', CLOUD_HEX, '"'),
      'the zqsecretterm host',
    ].join('\n'),
  );
  const findings = [
    ...scanTemp(file, { extraTerms: parseExtraTerms('zqsecretterm') }),
    ...wranglerIdentifierFindings('id = "zqsecretid0123"\ndatabase_id = "your-d1-id"'),
  ];
  assert.equal(findings.length, 12);
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
    glue('id ', glue(CLOUD_HEX, ' ').repeat(6_000)),
    glue('id ', glue(CLOUD_UUID, ' ').repeat(5_000)),
    'a_id '.repeat(40_000),
    'hidden-nam'.repeat(20_000),
  ];
  const started = performance.now();
  for (const input of inputs) contentFindings(input, { extraTerms: TERMS });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
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

const CLOUD = 'line 1: cloud identifier (use a your- placeholder)';

test('flags any 32-hex or UUID value that is not a placeholder, wherever it is', () => {
  for (const text of [
    // Whatever names it, or nothing at all
    glue('| **KV (prod)** | `', CLOUD_HEX, '` |'),
    glue('| **D1** | `', CLOUD_UUID, '` |'),
    glue('wrangler d1 execute ', CLOUD_UUID, ' --remote'),
    glue('https://', CLOUD_HEX, '.r2.cloudflarestorage.com/bucket'),
    glue('https://dash.cloudflare.com/', CLOUD_HEX, '/workers'),
    glue('  "', CLOUD_HEX, '"'),
    glue(CLOUD_HEX, ' is the account_id'),
    glue('checksum ', CLOUD_HEX),
    glue('account_id = "', CLOUD_HEX, '"'),
    glue('CF_ACCOUNT_ID=', CLOUD_HEX),
    glue('zone_id: ', CLOUD_HEX),
    glue('"zone_id": "', CLOUD_HEX.toUpperCase(), '"'),
    glue("CLOUDFLARE_ZONE_IDS = { 'example.com': '", CLOUD_HEX, "' }"),
    glue('accountId: "', CLOUD_HEX, '"'),
    glue('wrangler --account-id ', CLOUD_HEX),
    glue('GET /accounts/', CLOUD_HEX, '/workers/domains'),
    glue('| **Zone ID** | `', CLOUD_HEX, '` |'),
    glue('id = "', CLOUD_UUID, '"'),
    glue('database_id = "', CLOUD_UUID, '"'),
    glue('account_tag: ', CLOUD_HEX),
    // Encoded: the decoded form shows it
    glue('zone_id%3D', CLOUD_HEX),
  ]) {
    assert.deepEqual(contentFindings(text), [CLOUD], text);
  }
  for (const text of [
    // Longer digests and base64 are not one value
    glue('sha256 ', CLOUD_HEX, CLOUD_HEX),
    glue('id: sha512-', CLOUD_HEX, 'Zz'),
    glue('id ', CLOUD_HEX.slice(0, 31)),
    // Placeholders
    'account_id = "your-cloudflare-account-id"',
    glue('id = "', '0123456789abcdef', '0123456789abcdef"'),
    glue('id: "', '00000000-0000-0000-0000-', '000000000000"'),
    glue("id: '0190abcd-0000-", "7000-8000-00000000000a'"),
    glue('zone_id = "', 'f'.repeat(32), '"'),
    glue('id = "', '01234567-89ab-cdef-', '0123-456789abcdef"'),
  ]) {
    assert.deepEqual(contentFindings(text), [], text);
  }
});

test('placeholders are named by rule, not by list', () => {
  assert.equal(isPlaceholderIdentifier('0'.repeat(32)), true);
  assert.equal(isPlaceholderIdentifier('a'.repeat(32)), true);
  assert.equal(isPlaceholderIdentifier(CLOUD_HEX), false);
  assert.equal(isPlaceholderIdentifier(CLOUD_UUID), false);
  // No key is needed, before or after the value
  assert.equal(hasCloudIdentifier(glue('zone ', CLOUD_UUID)), true);
  assert.equal(hasCloudIdentifier(glue(CLOUD_UUID, ' zone')), true);
  assert.equal(hasCloudIdentifier(CLOUD_UUID), true);
});

test('the only identifier allowance is Drizzle snapshot ids, in snapshot files only', () => {
  assert.equal(ALLOWED_IDENTIFIER_LINES.length, 1);
  const dir = mkdtempSync(join(TEMP_DIRECTORY, 'ids-'));
  mkdirSync(join(dir, 'drizzle/meta'), { recursive: true });
  const line = glue('  "id": "', CLOUD_UUID, '",');
  writeFileSync(
    join(dir, 'drizzle/meta/0007_snapshot.json'),
    `{\n${line}\n  "zone_id": "${CLOUD_UUID}"\n}`,
  );
  writeFileSync(join(dir, 'drizzle/meta/notes.json'), line);
  assert.deepEqual(
    sanitizationFindings(['drizzle/meta/0007_snapshot.json', 'drizzle/meta/notes.json'], dir),
    [
      'drizzle/meta/0007_snapshot.json: line 3: cloud identifier (use a your- placeholder)',
      'drizzle/meta/notes.json: line 1: cloud identifier (use a your- placeholder)',
    ],
  );
});

test('a binary file fails unless it is pinned with its exact SHA-256', () => {
  const dir = mkdtempSync(join(TEMP_DIRECTORY, 'binary-'));
  const pinned = [...PINNED_BINARY_FILES.keys()][0];
  mkdirSync(join(dir, pinned, '..'), { recursive: true });
  writeFileSync(join(dir, pinned), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]));
  writeFileSync(join(dir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0x00, 0x10]));
  assert.deepEqual(sanitizationFindings([pinned, 'photo.jpg'], dir), [
    `${pinned}: binary file unlike its pin`,
    'photo.jpg: binary file that is not pinned',
  ]);
  // Every pin names a file of this repository, byte for byte
  for (const [file, digest] of PINNED_BINARY_FILES) {
    const bytes = readFileSync(join(REPO_ROOT, file));
    assert.ok(bytes.includes(0), `${file} is binary`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, file);
  }
  assert.deepEqual(sanitizationFindings([...PINNED_BINARY_FILES.keys()], REPO_ROOT), []);
});

/** A scratch git repository with one committed file, identity set locally. */
function scratchRepo(files = { 'README.md': 'hello\n' }) {
  const dir = mkdtempSync(join(TEMP_DIRECTORY, 'repo-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.name', 'Example');
  run('config', 'user.email', 'dev@example.com');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'core.hooksPath', '/dev/null');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  run('add', '.');
  run('commit', '--quiet', '-m', 'first');
  return { dir, run };
}

test('the terms file is read from the common git directory, shared by worktrees', () => {
  const { dir, run } = scratchRepo();
  const env = {};
  assert.equal(loadExtraTerms({ env, cwd: dir }), null);
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), 'hidden-name\n');
  assert.equal(loadExtraTerms({ env, cwd: dir }).length, 1);
  const worktree = join(dir, '..', `${dir.split('/').pop()}-wt`);
  run('worktree', 'add', '--quiet', worktree);
  assert.equal(loadExtraTerms({ env, cwd: worktree }).length, 1);
  // PUBLIC_CHECK_TERMS_FILE wins, and must exist when set
  const named = join(dir, 'other-terms.txt');
  writeFileSync(named, 'a\nb\n');
  assert.equal(loadExtraTerms({ env: { PUBLIC_CHECK_TERMS_FILE: named }, cwd: dir }).length, 2);
  assert.throws(
    () => loadExtraTerms({ env: { PUBLIC_CHECK_TERMS_FILE: join(dir, 'missing.txt') }, cwd: dir }),
    TermsFileError,
  );
  rmSync(worktree, { recursive: true, force: true });
});

const SCANNER_PATH = fileURLToPath(new URL('./check-public-sanitization.mjs', import.meta.url));

function runScanner(cwd, args = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const name of ['PUBLIC_CHECK_TERMS_FILE', 'PUBLIC_CHECK_COMMIT_EMAILS']) {
    if (!(name in env)) delete childEnv[name];
  }
  return spawnSync(process.execPath, [SCANNER_PATH, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
  });
}

test('the CLI says when only the generic rules ran, and names a term only by its line', () => {
  const { dir } = scratchRepo({
    'wrangler.toml': 'name = "x"\n',
    'notes.md': 'about hidden-name\n',
  });
  const plain = runScanner(dir);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^No extra terms file: only the generic rules ran\.$/m);
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), '# mine\nhidden-name\n');
  const flagged = runScanner(dir);
  assert.equal(flagged.status, 1);
  assert.match(flagged.stderr, /- notes\.md: line 1: extra term \(terms file line 2\)/);
  assert.ok(!`${flagged.stdout}${flagged.stderr}`.includes('hidden-name'));
  const missing = runScanner(dir, [], { PUBLIC_CHECK_TERMS_FILE: 'missing.txt' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /PUBLIC_CHECK_TERMS_FILE names a file that does not exist/);
});

test('commit messages get the generic rules and the extra terms', () => {
  const ok = { authorEmail: '1+dev@users.noreply.github.com', committerEmail: GITHUB_NOREPLY };
  assert.deepEqual(
    commitFindings('c', {
      ...ok,
      message: '[fix] Tidy\n\nChanges:\n- a\n\nFiles: 1 staged, 1 documented\n',
    }),
    [],
  );
  assert.deepEqual(
    commitFindings(
      'c',
      {
        ...ok,
        message: glue('[fix] Tidy\n\n', MAC_HOME, '\nsee hidden-name\n', TAILNET_HOST, '\n'),
      },
      { extraTerms: TERMS },
    ),
    [
      'c: line 3: home-directory path',
      'c: line 4: extra term (terms file line 3)',
      'c: line 5: Tailscale MagicDNS host',
    ],
  );
  // The email-address rule applies to a message only with the commit email
  // rule on; GitHub's service addresses sign merges and bot commits, so a
  // commit may then carry them; a file may not
  const on = { checkEmails: true };
  const signoff = glue('Signed-off-by: bot <', GITHUB_SUPPORT, '>');
  assert.deepEqual(commitFindings('c', { ...ok, message: signoff }, on), []);
  assert.deepEqual(contentFindings(signoff), ['line 1: email address outside the example domains']);
  assert.deepEqual(commitFindings('c', { ...ok, message: PRIVATE_EMAIL }, on), [
    'c: line 1: email address outside the example domains',
  ]);
  assert.deepEqual(commitFindings('c', { ...ok, message: PRIVATE_EMAIL }), []);
  // A verbose commit's diff after the scissors line is never part of the message
  const verbose = glue(
    '[fix] x\n# ------------------------ >8 ------------------------\n',
    MAC_HOME,
  );
  assert.deepEqual(commitFindings('c', { ...ok, message: verbose }), []);
  // A stored commit keeps its `#` lines, so `--commits` checks them; the hook
  // drops the lines git strips (the template's branch and file list)
  const commented = glue('[fix] x\n# On branch ', MAC_HOME, '\nsee ', MAC_HOME);
  assert.deepEqual(commitFindings('c', { ...ok, message: commented }), [
    'c: line 2: home-directory path',
    'c: line 3: home-directory path',
  ]);
  assert.deepEqual(commitFindings('c', { ...ok, message: commented }, { commentChar: '#' }), [
    'c: line 3: home-directory path',
  ]);
  assert.deepEqual(commitFindings('c', { ...ok, message: commented }, { commentChar: ';' }), [
    'c: line 2: home-directory path',
    'c: line 3: home-directory path',
  ]);
});

test('commit identities must be GitHub no-reply or example-domain addresses', () => {
  for (const email of [
    '35658846+someone@users.noreply.github.com',
    'dev@example.com',
    'dev@ci.example.org',
    'dev@build.example',
    GITHUB_NOREPLY,
    GITHUB_SUPPORT.toUpperCase(),
  ]) {
    assert.equal(identityEmailAllowed(email), true, email);
  }
  for (const email of [
    PRIVATE_EMAIL,
    glue('dev', '@', 'github.com'),
    '',
    'dev',
    '@example.com',
    'dev@',
  ]) {
    assert.equal(identityEmailAllowed(email), false, email);
  }
  const on = { checkEmails: true };
  assert.deepEqual(
    commitFindings(
      'c',
      { message: 'x', authorEmail: PRIVATE_EMAIL, committerEmail: 'dev@example.com' },
      on,
    ),
    ['c: author email is not a GitHub no-reply or example-domain address'],
  );
  const both = commitFindings(
    'c',
    { message: 'x', authorEmail: '', committerEmail: PRIVATE_EMAIL },
    on,
  );
  assert.equal(both.length, 2);
  // Off (the default), no identity is examined
  assert.deepEqual(
    commitFindings('c', { message: 'x', authorEmail: PRIVATE_EMAIL, committerEmail: '' }),
    [],
  );
  for (const finding of both) assert.ok(!finding.includes(PRIVATE_EMAIL));
});

const all = () => true;
const none = () => false;
const present = rev => rev !== 'gone';

test('CI checks only the commits a push or pull request adds', () => {
  const head = 'b'.repeat(40);
  assert.deepEqual(
    ciRevListArgs({ EVENT_NAME: 'pull_request', PR_BASE_SHA: 'base', PR_HEAD_SHA: 'tip' }, all),
    ['base..tip'],
  );
  assert.throws(
    () => ciRevListArgs({ EVENT_NAME: 'pull_request', PR_BASE_SHA: 'base' }, all),
    CommitRangeError,
  );
  assert.deepEqual(
    ciRevListArgs({ EVENT_NAME: 'push', PUSH_BEFORE: 'old', GITHUB_SHA: head }, all),
    [`old..${head}`],
  );
  // A new branch or tag: the commits not on the default branch
  const created = { EVENT_NAME: 'push', PUSH_BEFORE: '0'.repeat(40), GITHUB_SHA: head };
  assert.deepEqual(ciRevListArgs({ ...created, DEFAULT_BRANCH: 'trunk' }, all), [
    head,
    '--not',
    'origin/trunk',
  ]);
  assert.deepEqual(ciRevListArgs(created, all), [head, '--not', 'origin/main']);
  // A force-push whose old tip is present: the commits it does not reach
  assert.deepEqual(
    ciRevListArgs(
      { EVENT_NAME: 'push', PUSH_BEFORE: 'old', GITHUB_SHA: head, GITHUB_REF: 'refs/heads/main' },
      all,
    ),
    [`old..${head}`],
  );
  // A force-push whose old tip was not fetched: on another branch, the commits
  // not on the default branch; on the default branch itself the range is
  // unknown, which fails rather than passing on no commits
  const forced = { EVENT_NAME: 'push', PUSH_BEFORE: 'gone', GITHUB_SHA: head };
  assert.deepEqual(ciRevListArgs({ ...forced, GITHUB_REF: 'refs/heads/topic' }, present), [
    head,
    '--not',
    'origin/main',
  ]);
  for (const env of [
    { ...forced, GITHUB_REF: 'refs/heads/main' },
    { ...forced, GITHUB_REF: 'refs/heads/trunk', DEFAULT_BRANCH: 'trunk' },
    { ...forced, GITHUB_REF: 'refs/heads/topic' },
  ]) {
    const hasCommit = env.GITHUB_REF === 'refs/heads/topic' ? none : present;
    assert.throws(
      () => ciRevListArgs(env, hasCommit),
      error => error instanceof CommitRangeError && /Commit range unknown/.test(error.message),
      JSON.stringify(env),
    );
  }
  // A manual run, and no default branch at all: the run's own commit only
  assert.deepEqual(ciRevListArgs({ EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: head }, all), [
    head,
    '--not',
    'origin/main',
  ]);
  assert.deepEqual(ciRevListArgs({ EVENT_NAME: 'workflow_dispatch' }, none), [
    '--max-count=1',
    'HEAD',
  ]);
});

test('a commit range is checked commit by commit, by short hash', () => {
  const { dir, run } = scratchRepo();
  const base = run('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  run('add', 'a.txt');
  run('commit', '--quiet', '-m', glue('[fix] a\n\nsee ', MAC_HOME));
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  run('add', 'b.txt');
  execFileSync('git', ['commit', '--quiet', '-m', '[fix] b'], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_EMAIL: PRIVATE_EMAIL },
  });
  const [second, first] = run('rev-list', `${base}..HEAD`).trim().split('\n');
  const { count, findings } = commitRangeFindings([`${base}..HEAD`], {
    cwd: dir,
    checkEmails: true,
  });
  assert.equal(count, 2);
  assert.deepEqual(findings, [
    `commit ${second.slice(0, 12)}: author email is not a GitHub no-reply or example-domain address`,
    `commit ${first.slice(0, 12)}: line 3: home-directory path`,
  ]);
  assert.deepEqual(commitRangeFindings([`${base}..HEAD`], { cwd: dir }).findings, [
    `commit ${first.slice(0, 12)}: line 3: home-directory path`,
  ]);
  const cli = runScanner(dir, ['--commits', `${base}..HEAD`]);
  assert.equal(cli.status, 1);
  assert.ok(!cli.stderr.includes(PRIVATE_EMAIL));
  const clean = runScanner(dir, ['--commits', `${base}..${base}`]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /passed \(0 commits\)/);
});

test('the commit-msg mode checks the message file and both identities', () => {
  const { dir } = scratchRepo();
  const message = join(dir, '.git', 'COMMIT_EDITMSG');
  writeFileSync(message, '[docs] Tidy\n\nFiles: 1 staged, 1 documented\n');
  const ok = runScanner(dir, ['--commit-msg', message]);
  assert.equal(ok.status, 0, ok.stderr);
  const badIdentity = runScanner(dir, ['--commit-msg', message], {
    GIT_COMMITTER_EMAIL: PRIVATE_EMAIL,
    PUBLIC_CHECK_COMMIT_EMAILS: 'noreply',
  });
  assert.equal(badIdentity.status, 1);
  assert.match(badIdentity.stderr, /commit message: committer email is not/);
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), 'hidden-name\n');
  writeFileSync(message, '[docs] Tidy hidden-name\n');
  const term = runScanner(dir, ['--commit-msg', message]);
  assert.equal(term.status, 1);
  assert.match(term.stderr, /commit message: line 1: extra term \(terms file line 1\)/);
  assert.ok(!term.stderr.includes('hidden-name'));
  assert.equal(runScanner(dir, ['--commit-msg']).status, 1);
  assert.ok(existsSync(message));
});

test('husky runs the commit-msg mode, and CI checks the commits a run adds', () => {
  const hook = readFileSync(join(REPO_ROOT, '.husky/commit-msg'), 'utf8');
  assert.match(hook, /^node scripts\/check-public-sanitization\.mjs --commit-msg "\$1"$/m);
  const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: node scripts\/check-public-sanitization\.mjs --ci-commits$/m);
  for (const name of [
    'EVENT_NAME',
    'PR_BASE_SHA',
    'PR_HEAD_SHA',
    'PUSH_BEFORE',
    'DEFAULT_BRANCH',
  ]) {
    assert.match(ci, new RegExp(`^ {10}${name}: \\$\\{\\{ github\\.`, 'm'), name);
  }
  // Commit emails are opt-in per repository, through a repository variable
  assert.match(
    ci,
    /^ {10}PUBLIC_CHECK_COMMIT_EMAILS: \$\{\{ vars\.PUBLIC_CHECK_COMMIT_EMAILS \}\}$/m,
  );
  assert.match(ci, /fetch-depth: 0/);
});

/**
 * A scratch repository whose one new commit has an ordinary author and
 * committer email and trailers carrying it, as a fork's commits may.
 */
function ordinaryCommitRepo() {
  const repo = scratchRepo();
  const base = repo.run('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo.dir, 'c.txt'), 'c\n');
  repo.run('add', 'c.txt');
  const message = glue(
    '[fix] c\n\nSigned-off-by: Dev <',
    PRIVATE_EMAIL,
    '>\nCo-authored-by: Other <',
    PRIVATE_EMAIL,
    '>\n',
  );
  execFileSync('git', ['commit', '--quiet', '-m', message], {
    cwd: repo.dir,
    env: { ...process.env, GIT_AUTHOR_EMAIL: PRIVATE_EMAIL, GIT_COMMITTER_EMAIL: PRIVATE_EMAIL },
  });
  const head = repo.run('rev-parse', 'HEAD').trim();
  const messageFile = join(repo.dir, '.git', 'COMMIT_EDITMSG');
  writeFileSync(messageFile, message);
  const ci = { EVENT_NAME: 'push', PUSH_BEFORE: base, GITHUB_SHA: head };
  return { ...repo, base, head, messageFile, ci };
}

const IDENTITY_ENV = { GIT_AUTHOR_EMAIL: PRIVATE_EMAIL, GIT_COMMITTER_EMAIL: PRIVATE_EMAIL };

test('the commit email rule is off by default: ordinary emails and trailers pass in all three modes', () => {
  const { dir, base, messageFile, ci } = ordinaryCommitRepo();
  for (const [args, env] of [
    [['--commit-msg', messageFile], IDENTITY_ENV],
    [['--commits', `${base}..HEAD`], {}],
    [['--ci-commits'], ci],
  ]) {
    const result = runScanner(dir, args, env);
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    assert.match(result.stdout, /^Commit emails: not checked/m, args[0]);
  }
  // An empty CI variable (a fork that never set it) is off too
  const unset = runScanner(dir, ['--ci-commits'], { ...ci, PUBLIC_CHECK_COMMIT_EMAILS: '' });
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(commitEmailsChecked({}, null), false);
  assert.equal(
    commitEmailsChecked({ PUBLIC_CHECK_COMMIT_EMAILS: ' ' }, { commitEmails: null }),
    false,
  );
});

test('PUBLIC_CHECK_COMMIT_EMAILS=noreply turns the commit email rule on in all three modes', () => {
  const { dir, base, messageFile, ci } = ordinaryCommitRepo();
  const on = { PUBLIC_CHECK_COMMIT_EMAILS: 'noreply' };
  for (const [args, env] of [
    [['--commit-msg', messageFile], { ...IDENTITY_ENV, ...on }],
    [['--commits', `${base}..HEAD`], on],
    [['--ci-commits'], { ...ci, ...on }],
  ]) {
    const result = runScanner(dir, args, env);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stdout, /^Commit emails: checked/m, args[0]);
    assert.match(result.stderr, /author email is not a GitHub no-reply/, args[0]);
    assert.match(result.stderr, /committer email is not a GitHub no-reply/, args[0]);
    assert.match(result.stderr, /line 3: email address outside the example domains/, args[0]);
    assert.match(result.stderr, /line 4: email address outside the example domains/, args[0]);
    assert.ok(!result.stderr.includes(PRIVATE_EMAIL), args[0]);
  }
  assert.equal(commitEmailsChecked(on, null), true);
  assert.equal(commitEmailsChecked({ PUBLIC_CHECK_COMMIT_EMAILS: 'NoReply' }, null), true);
});

test('the terms file directive commit-emails: noreply turns the rule on, and is not a term', () => {
  const { dir, base, messageFile } = ordinaryCommitRepo();
  const parsed = parseTermsFile('# mine\nhidden-name\n  Commit-Emails:  NoReply \n');
  assert.equal(parsed.terms.length, 1);
  assert.equal(parsed.commitEmails, 'noreply');
  assert.equal(parseTermsFile('hidden-name\n').commitEmails, null);
  assert.equal(commitEmailsChecked({}, parsed), true);
  // The directive is not matched as a term against content
  assert.deepEqual(contentFindings('commit-emails: noreply', { extraTerms: parsed.terms }), []);
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), 'commit-emails: noreply\n');
  for (const [args, env] of [
    [['--commit-msg', messageFile], IDENTITY_ENV],
    [['--commits', `${base}..HEAD`], {}],
  ]) {
    const result = runScanner(dir, args, env);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stdout, /^Extra terms file: 0 terms\.$/m);
    assert.match(result.stderr, /author email is not a GitHub no-reply/, args[0]);
  }
  // A file scan is unchanged by the directive
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "x"\n');
  assert.equal(runScanner(dir).status, 0);
});

test('a commit-emails value other than noreply is refused, never a silent off', () => {
  for (const text of [
    'x\ncommit-emails: zqeveryone',
    'x\ncommit-emails:',
    'x\ncommit-emails: off',
  ]) {
    assert.throws(
      () => parseTermsFile(text),
      error =>
        error instanceof TermsFileError &&
        /line 2/.test(error.message) &&
        !error.message.includes('zqeveryone'),
      text,
    );
  }
  assert.throws(
    () => commitEmailsChecked({ PUBLIC_CHECK_COMMIT_EMAILS: 'zqeveryone' }, null),
    error => error instanceof CheckSettingError && !error.message.includes('zqeveryone'),
  );
  const { dir, base } = ordinaryCommitRepo();
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "x"\n');
  const badEnv = runScanner(dir, ['--commits', `${base}..HEAD`], {
    PUBLIC_CHECK_COMMIT_EMAILS: 'yes',
  });
  assert.equal(badEnv.status, 1);
  assert.match(badEnv.stderr, /PUBLIC_CHECK_COMMIT_EMAILS takes the value noreply/);
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), '# mine\ncommit-emails: all\n');
  for (const args of [[], ['--commits', `${base}..HEAD`]]) {
    const result = runScanner(dir, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /terms file line 2: commit-emails takes the value noreply/);
  }
});

test('the CLI fails with one line, not a stack, when the CI commit range is unknown', () => {
  const { dir } = scratchRepo();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const result = runScanner(dir, ['--ci-commits'], {
    EVENT_NAME: 'push',
    PUSH_BEFORE: 'f'.repeat(40),
    GITHUB_SHA: head,
    GITHUB_REF: 'refs/heads/main',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Commit range unknown: /m);
  assert.doesNotMatch(result.stderr, /\bat \S+:\d+:\d+/);
});

test('a terms path that is not a readable regular file fails closed in one line', () => {
  const { dir } = scratchRepo({ 'wrangler.toml': 'name = "x"\n' });
  const termsPath = join(dir, '.git', 'public-check-terms.txt');
  const cases = [
    ['a dangling link', () => symlinkSync(join(dir, 'missing-target.txt'), termsPath)],
    ['a directory', () => mkdirSync(termsPath)],
  ];
  if (process.getuid?.() !== 0) {
    cases.push([
      'an unreadable file',
      () => {
        writeFileSync(termsPath, 'hidden-name\n');
        chmodSync(termsPath, 0o000);
      },
    ]);
  }
  for (const [name, make] of cases) {
    rmSync(termsPath, { recursive: true, force: true });
    make();
    assert.throws(() => loadTermsFile({ env: {}, cwd: dir }), TermsFileError, name);
    const result = runScanner(dir);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /^The public check terms file cannot be read/m, name);
    assert.doesNotMatch(result.stderr, /\bat \S+:\d+:\d+/, name);
    // A named file behaves the same way
    assert.equal(runScanner(dir, [], { PUBLIC_CHECK_TERMS_FILE: termsPath }).status, 1, name);
    if (name === 'an unreadable file') chmodSync(termsPath, 0o600);
  }
  // A link to a readable file is read; only a path where nothing exists is "none"
  rmSync(termsPath, { recursive: true, force: true });
  writeFileSync(join(dir, 'real-terms.txt'), 'hidden-name\n');
  symlinkSync(join(dir, 'real-terms.txt'), termsPath);
  assert.equal(loadTermsFile({ env: {}, cwd: dir }).terms.length, 1);
  rmSync(termsPath);
  assert.equal(loadTermsFile({ env: {}, cwd: dir }), null);
});

test('file paths get the content rules and the extra terms, reported by position', () => {
  const dir = mkdtempSync(join(TEMP_DIRECTORY, 'paths-'));
  const files = ['plain.txt', 'notes-hidden-name.md', glue('data-', CLOUD_HEX, '.json')];
  for (const file of files) writeFileSync(join(dir, file), glue('see ', MAC_HOME, '\n'));
  const findings = sanitizationFindings(files, dir, { extraTerms: TERMS });
  assert.deepEqual(findings, [
    'plain.txt: line 1: home-directory path',
    'candidate file #2: path: extra term (terms file line 3)',
    'candidate file #2: line 1: home-directory path',
    'candidate file #3: path: cloud identifier (use a your- placeholder)',
    'candidate file #3: line 1: home-directory path',
  ]);
  for (const finding of findings) {
    assert.ok(!finding.includes('hidden-name') && !finding.includes(CLOUD_HEX), finding);
  }
  // The repository's own paths pass
  assert.deepEqual(
    contentFindings(publicCandidateFiles(REPO_ROOT).join('\n')).filter(f => !f.includes('extra')),
    [],
  );
});

test('author and committer names get the content rules and the extra terms', () => {
  const ok = { authorEmail: GITHUB_NOREPLY, committerEmail: GITHUB_NOREPLY };
  assert.deepEqual(
    commitFindings(
      'c',
      { ...ok, message: 'x', authorName: 'Hidden-Name Bot', committerName: TAILNET_HOST },
      { extraTerms: TERMS },
    ),
    [
      'c: author name: extra term (terms file line 3)',
      'c: committer name: Tailscale MagicDNS host',
    ],
  );
  assert.deepEqual(commitFindings('c', { ...ok, message: 'x', authorName: 'Dev' }), []);
  const { dir, run } = scratchRepo();
  const base = run('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'n.txt'), 'n\n');
  run('add', 'n.txt');
  execFileSync('git', ['commit', '--quiet', '-m', '[fix] n'], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Hidden-Name Bot' },
  });
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), '\n\nhidden-name\n');
  const range = runScanner(dir, ['--commits', `${base}..HEAD`]);
  assert.equal(range.status, 1);
  assert.match(range.stderr, /: author name: extra term \(terms file line 3\)/);
  assert.ok(!range.stderr.includes('Hidden-Name'));
  const message = join(dir, '.git', 'COMMIT_EDITMSG');
  writeFileSync(message, '[docs] x\n');
  const hook = runScanner(dir, ['--commit-msg', message], { GIT_COMMITTER_NAME: 'Hidden-Name' });
  assert.equal(hook.status, 1);
  assert.match(hook.stderr, /commit message: committer name: extra term/);
});

test('the commit-msg mode drops the template lines git strips, by its comment character', () => {
  const { dir, run } = scratchRepo();
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), 'hidden-name\n');
  const message = join(dir, '.git', 'COMMIT_EDITMSG');
  writeFileSync(message, '[docs] x\n# On branch hidden-name\n#\tmodified: hidden-name.md\n');
  const stripped = runScanner(dir, ['--commit-msg', message]);
  assert.equal(stripped.status, 0, stripped.stderr);
  // Another comment character: the `#` lines are message text again
  run('config', 'core.commentChar', ';');
  const kept = runScanner(dir, ['--commit-msg', message]);
  assert.equal(kept.status, 1);
  assert.match(kept.stderr, /commit message: line 2: extra term/);
});

const line = (localSha, remoteSha) => `refs/heads/topic ${localSha} refs/heads/topic ${remoteSha}`;

test('the pre-push range is per pushed ref, with an upstream or remote fallback', () => {
  const zero = '0'.repeat(40);
  const local = 'a'.repeat(40);
  const remote = 'c'.repeat(40);
  assert.deepEqual(prePushRevListArgs(line(local, remote), all, none), [[`${remote}..${local}`]]);
  // A new remote ref, or a remote tip not present here: commits on no remote ref
  for (const [input, hasCommit] of [
    [line(local, zero), all],
    [line(local, remote), none],
  ]) {
    assert.deepEqual(prePushRevListArgs(input, hasCommit, none), [[local, '--not', '--remotes']]);
  }
  // A deleted ref adds nothing; two refs give two ranges
  assert.deepEqual(prePushRevListArgs(line(zero, remote), all, none), []);
  assert.deepEqual(
    prePushRevListArgs(`${line(local, remote)}\n${line(remote, zero)}\n`, all, none),
    [[`${remote}..${local}`], [remote, '--not', '--remotes']],
  );
  // A hand run: the upstream, else the commits on no remote ref
  assert.deepEqual(prePushRevListArgs('', all, all), [['@{u}..HEAD']]);
  assert.deepEqual(prePushRevListArgs('\n', all, none), [['HEAD', '--not', '--remotes']]);
});

test('the pre-push mode is inert without a terms file, and checks tree and commits with one', () => {
  const { dir, run } = scratchRepo({ 'wrangler.toml': 'name = "x"\n', 'a.md': 'hidden-name\n' });
  const head = run('rev-parse', 'HEAD').trim();
  const push = `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`;
  const prePush = env =>
    spawnSync(process.execPath, [SCANNER_PATH, '--pre-push'], {
      cwd: dir,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(
          ([name]) => !name.startsWith('PUBLIC_CHECK_') || name in env,
        ),
      ),
      input: push,
      encoding: 'utf8',
    });
  const off = prePush({});
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /^No extra terms file: the pre-push public check is off\.$/m);
  writeFileSync(join(dir, '.git', 'public-check-terms.txt'), 'hidden-name\n');
  const on = prePush({});
  assert.equal(on.status, 1);
  assert.match(on.stderr, /- a\.md: line 1: extra term \(terms file line 1\)/);
  assert.ok(!on.stderr.includes('hidden-name'));
  // The commits pushed are checked too (the whole new history here: 1 commit)
  writeFileSync(join(dir, 'a.md'), 'clean\n');
  run('commit', '--quiet', '-am', '[docs] hidden-name');
  const head2 = run('rev-parse', 'HEAD').trim();
  const pushed = spawnSync(process.execPath, [SCANNER_PATH, '--pre-push'], {
    cwd: dir,
    env: process.env,
    input: `refs/heads/main ${head2} refs/heads/main ${head}\n`,
    encoding: 'utf8',
  });
  assert.equal(pushed.status, 1);
  assert.match(pushed.stderr, /: line 1: extra term \(terms file line 1\)/);
  assert.doesNotMatch(pushed.stderr, /a\.md/);
  // PUBLIC_CHECK_TERMS_FILE turns it on too
  rmSync(join(dir, '.git', 'public-check-terms.txt'));
  const namedFile = join(dir, '..', `${basename(dir)}-terms.txt`);
  writeFileSync(namedFile, 'hidden-name\n');
  writeFileSync(join(dir, 'a.md'), 'hidden-name\n');
  assert.equal(prePush({}).status, 0);
  assert.equal(prePush({ PUBLIC_CHECK_TERMS_FILE: namedFile }).status, 1);
  const hook = readFileSync(join(REPO_ROOT, '.husky/pre-push'), 'utf8');
  assert.match(hook, /^node scripts\/check-public-sanitization\.mjs --pre-push$/m);
});
