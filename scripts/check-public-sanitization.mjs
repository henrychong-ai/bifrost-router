#!/usr/bin/env node

/**
 * Public-content gate (`pnpm run public:check`).
 *
 * This repository is public. The gate scans every release-candidate file
 * (tracked, plus untracked files git does not ignore) and fails on content that
 * belongs only in private infrastructure. It scans itself and its own test too,
 * so neither may spell out a value it blocks: describe the bad shape instead,
 * or assemble a synthetic one at runtime in the test.
 *
 * Findings name the file, the line and the rule, never the matched text: CI
 * logs of a public repository are public too.
 *
 * Each line is checked in four forms, and fails if any form matches:
 *   (a) as written, where a backslash or percent sign is just a delimiter;
 *   (b) with every escape (a percent-encoded byte, a backslash escape) blanked
 *       to spaces, so an escape cannot glue a character onto a name;
 *   (c) decoded: percent-encoded ASCII bytes, `\u` and `\x` escapes and the
 *       simple backslash escapes are turned back into the characters they
 *       stand for, so an encoded hyphen or slash cannot hide a name;
 *   (d) partly decoded: as (c) for percent, `\u` and `\x` escapes and for a
 *       backslash before punctuation (a Markdown `\-`), with every other
 *       backslash kept as a separator, so an encoded name inside a Windows
 *       path is not glued to its neighbours.
 *
 * Generic rules, which need no identifier at all:
 *   - a home-directory path, with or without a trailing separator: a macOS
 *     `Users` directory (capital U, matched anywhere, so under a volume or
 *     WSL mount and in a source map too; the `Shared` directory is allowed),
 *     a Windows drive's `Users` directory with either slash (the profile name
 *     may contain spaces), or a Linux `home` or `var/home` directory (the
 *     `node` and `runner` container and CI users are allowed). A lower-case
 *     `users` segment is an application route and is not flagged, and a
 *     name in angle brackets is a placeholder;
 *   - a Tailscale MagicDNS host (anything under `ts.net`), unless its tailnet
 *     label is a `your-` placeholder;
 *   - an email address, unless its domain is an RFC 2606 example domain
 *     (example.com, example.org, example.net or a subdomain of one, or any
 *     `.example` name) or the GitHub no-reply domain. An scp-style git remote
 *     and a `name@2x.png`-style asset name are not addresses, and neither is
 *     a version pin, whose top-level label is not alphabetic;
 *   - a 1Password secret reference that is not a `your-vault` /
 *     `your-1password` placeholder;
 *   - a numbered private host name of the `vps-` form;
 *   - a single-label `https://` host (see `singleLabelHostFindings`);
 *   - a cloud identifier: a 32-hex value or a UUID after an identifier key on
 *     the same line (see `hasCloudIdentifier`), unless it is an obvious
 *     placeholder (`isPlaceholderIdentifier`) or on an allowed line
 *     (`ALLOWED_IDENTIFIER_LINES`).
 *
 * Binary files: a file holding a NUL byte cannot be read as text, so it fails
 * unless it is on `PINNED_BINARY_FILES` with its exact SHA-256.
 *
 * Extra terms (optional, never committed): a clone may keep a list of its own
 * private names, one term per line, in `PUBLIC_CHECK_TERMS_FILE` or, when that
 * is unset, in `public-check-terms.txt` inside the clone's git directory
 * (`git rev-parse --git-common-dir`, so every worktree of the clone shares it
 * and it can never be staged). Blank lines and lines starting `#` are skipped;
 * a term matches as a case-insensitive substring of any of a line's forms; a
 * line starting `re:` is a regular expression, applied case-insensitively.
 * The one directive line, `commit-emails: noreply`, turns on the commit email
 * rule below (any other value is an error naming the line). Findings name the
 * terms file's line, never the term. Without the file the check says that
 * only the generic rules ran, and passes. CI has no terms file.
 *
 * Commit messages: `--commit-msg <file>` (the husky `commit-msg` hook) checks
 * the message being written, and `--commits <rev-list arguments>` or
 * `--ci-commits` (CI: the commits a push or pull request adds, see
 * `ciRevListArgs`) check existing commits. Each applies the generic rules
 * (except the email-address rule) and the extra terms to the subject and body.
 *
 * Commit emails (opt-in, off by default, so a fork with ordinary git emails
 * is unaffected): with `PUBLIC_CHECK_COMMIT_EMAILS=noreply` in the
 * environment, or the terms file's `commit-emails: noreply` directive, the
 * author and committer emails must be GitHub no-reply or example-domain
 * addresses (`identityEmailAllowed`; GitHub's own service addresses, which
 * sign merges and bot commits, are allowed too), and the email-address rule
 * applies to the message as well. Off, no email is examined, so a
 * `Signed-off-by:` or `Co-authored-by:` trailer with a real address passes.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN_PATHS = [
  /(^|\/)\.claude\//,
  /(^|\/)\.dev\.vars(?:\.|$)/,
  /(^|\/)plans\//,
  /(^|\/)security-reports\//,
];

/**
 * The binary files the tree may hold, each pinned to its SHA-256: the
 * dashboard's bundled fonts (unmodified upstream files, admin/public/fonts).
 * A new or changed binary file needs its own entry, checked by hand first.
 */
export const PINNED_BINARY_FILES = new Map([
  [
    'admin/public/fonts/inter-4.1/inter-variable-italic.woff2',
    'e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a',
  ],
  [
    'admin/public/fonts/inter-4.1/inter-variable.woff2',
    '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3',
  ],
  [
    'admin/public/fonts/maple-mono-7.9/maple-mono-nl-italic.woff2',
    '211e93c6351ad86c3378d061903b5ce1d28490f36fb2f2215305c3d5958561a5',
  ],
  [
    'admin/public/fonts/maple-mono-7.9/maple-mono-nl.woff2',
    'a7fb30bf825a1f5aae9a81a91f8cf894c07a50b5a711d9b02a333ad7e0c87e9e',
  ],
]);

/**
 * Lines where a UUID after an `id` key is not a cloud identifier: Drizzle
 * Kit's migration snapshots name each snapshot and its predecessor with a
 * random UUID (`id`, `prevId`) that identifies nothing outside this
 * repository.
 */
export const ALLOWED_IDENTIFIER_LINES = [
  {
    file: /^drizzle\/meta\/\d{4}_snapshot\.json$/,
    line: /^\s*"(?:id|prevId)": "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",?$/,
  },
];

const IDENTIFIER_TOKEN = /[a-z0-9.-]+/g;

function tokensOf(text) {
  return text.toLowerCase().match(IDENTIFIER_TOKEN) ?? [];
}

// Form (b): a percent-encoded byte or a backslash escape, blanked.
const ESCAPE_SEQUENCE = /%[0-9a-f]{2}|\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|.)/gi;

function blankEscapes(line) {
  return line.replace(ESCAPE_SEQUENCE, escape => ' '.repeat(escape.length));
}

// Form (c): the same escapes, decoded. A control character, or a non-ASCII
// byte that is only part of a UTF-8 sequence, becomes a space.
const DECODABLE_ESCAPE = /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|%([0-9a-f]{2})|\\(.)/gi;
const CONTROL_ESCAPES = new Set(['n', 'r', 't', 'b', 'f', 'v', '0']);

function decodeEscapes(line) {
  return line.replace(DECODABLE_ESCAPE, (escape, unicode, hex, percent, simple) => {
    if (simple !== undefined) return CONTROL_ESCAPES.has(simple) ? ' ' : simple;
    return decodedCharacter(unicode, hex, percent);
  });
}

function decodedCharacter(unicode, hex, percent) {
  const code = Number.parseInt(unicode ?? hex ?? percent, 16);
  if (code < 0x20 || (unicode === undefined && code >= 0x80)) return ' ';
  return String.fromCharCode(code);
}

// Form (d): percent, `\u` and `\x` escapes and a backslash before
// punctuation (a Markdown `\-`) decoded, every other backslash kept, so a
// Windows path separator still separates the name from its neighbours.
const CODE_OR_PUNCTUATION_ESCAPE =
  /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|%([0-9a-f]{2})|\\([^\\a-z0-9\s])/gi;

function decodeCodesAndPunctuation(line) {
  return line.replace(CODE_OR_PUNCTUATION_ESCAPE, (escape, unicode, hex, percent, punctuation) => {
    if (punctuation !== undefined) return punctuation;
    return decodedCharacter(unicode, hex, percent);
  });
}

function lineForms(line) {
  return [
    ...new Set([line, blankEscapes(line), decodeEscapes(line), decodeCodesAndPunctuation(line)]),
  ];
}

// A user name in a path ends at a separator, quote, whitespace or the end of
// the line; there need not be a trailing slash. It holds no angle bracket, so
// a documented `<user>` placeholder is not a user. A Windows profile name may
// contain spaces, so it ends only at a separator or quote. Slashes are written
// as `[/]` so the decoded form of this file does not spell out a path it
// blocks.
const MAC_HOME = /[/]Users[/]([^/\\\s'"`<>]+)/g;
const WINDOWS_HOME = /\b[a-z]:[\\/]+users[\\/]+([^/\\'"`<>]+)/gi;
const LINUX_HOME = /(?<![\w.-])(?:[/]var)?[/]home[/]([^/\\\s'"`<>]+)/g;
const ALLOWED_MAC_USERS = new Set(['Shared']);
const ALLOWED_LINUX_USERS = new Set(['node', 'runner']);

function hasUser(form, pattern, allowed = new Set()) {
  for (const match of form.matchAll(pattern)) {
    const name = match[1].trim();
    if (name !== '' && !allowed.has(name)) return true;
  }
  return false;
}

function hasHomePath(form) {
  return (
    hasUser(form, MAC_HOME, ALLOWED_MAC_USERS) ||
    hasUser(form, WINDOWS_HOME) ||
    hasUser(form, LINUX_HOME, ALLOWED_LINUX_USERS)
  );
}

// Token-based, so it stays linear on a long run of labels. The labels are
// compared whole (`ts`, then `net`), never as a substring of the token: a
// substring test is the shape code scanning reads as an incomplete host check
// (v1.39.0), and a label test is the exact rule anyway.
function hasTailnetHost(form) {
  for (const token of tokensOf(form)) {
    const labels = token.split('.');
    for (let i = 1; i + 1 < labels.length; i++) {
      const tailnet = labels[i - 1];
      if (labels[i] === 'ts' && labels[i + 1] === 'net' && tailnet !== '') {
        if (!tailnet.startsWith('your-')) return true;
      }
    }
  }
  return false;
}

// The top-level label must be alphabetic, so a `package@1.2.3` version pin is
// not read as an address.
const EMAIL_ADDRESS =
  /(?<![a-z0-9._%+-])([a-z0-9._%+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?![a-z0-9-])/gi;
const EXAMPLE_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.example)$/;
const ALLOWED_EMAIL_DOMAINS = new Set(['users.noreply.github.com']);
/**
 * GitHub's own service addresses: the committer of a merge or edit made on
 * GitHub, and the sign-off of its dependency-update bot. Allowed in commits
 * only, never in a file.
 */
export const GITHUB_SERVICE_ADDRESSES = new Set(
  ['noreply', 'support'].map(local => `${local}@github.com`),
);
// `icon@2x.png`, `logo@1.5x.webp`: a resolution suffix, not a domain.
const ASSET_SCALE_SUFFIX = /^\d+(?:\.\d+)?x\.[a-z0-9]+$/;

function emailAllowed(local, domain, allowedAddresses) {
  if (EXAMPLE_EMAIL_DOMAIN.test(domain) || ALLOWED_EMAIL_DOMAINS.has(domain)) return true;
  return allowedAddresses.has(`${local}@${domain}`);
}

function privateEmailRule(allowedAddresses) {
  return form => {
    for (const match of form.matchAll(EMAIL_ADDRESS)) {
      const local = match[1].toLowerCase();
      const domain = match[2].toLowerCase();
      const next = form[match.index + match[0].length];
      if (local === 'git' && (next === ':' || next === '/')) continue;
      if (ASSET_SCALE_SUFFIX.test(domain)) continue;
      if (emailAllowed(local, domain, allowedAddresses)) continue;
      return true;
    }
    return false;
  };
}

/**
 * Whether a commit's author or committer email may be published: a GitHub
 * no-reply address, an RFC 2606 example-domain address, or one of GitHub's
 * service addresses.
 */
export function identityEmailAllowed(email) {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0 || at === lower.length - 1) return false;
  return emailAllowed(lower.slice(0, at), lower.slice(at + 1), GITHUB_SERVICE_ADDRESSES);
}

const NUMBERED_PRIVATE_HOST = /\bvps-\d+\b/i;
const SECRET_REFERENCE = /\bop:[/][/](?!your-(?:vault|1password)\b)/i;

// A 32-hex value or a UUID, standing alone: no letter or digit on either side,
// so a longer digest (a 64-hex pin, a base64 integrity string) is not one.
const CLOUD_IDENTIFIER_VALUE =
  /(?<![0-9a-z])(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z])/gi;
const KEY_WORD = /[A-Za-z][A-Za-z0-9_-]*/g;
const ID_KEY_WORDS = new Set([
  'id',
  'ids',
  'uuid',
  'account',
  'accounts',
  'zone',
  'zones',
  'namespace',
  'namespaces',
  'database',
  'databases',
]);

/**
 * Whether a word names an identifier: `id`, `uuid`, an account, zone,
 * namespace or database (`/accounts/<value>` included), a `_id`/`-id` suffix
 * in any case (`account_id`, `CF_ACCOUNT_ID`, `CLOUDFLARE_ZONE_IDS`,
 * `--zone-id`), a camel-case `Id` suffix (`accountId`), or any word with an
 * `account` or `zone` part (`account_tag`).
 */
export function isIdentifierKey(word) {
  const lower = word.toLowerCase();
  if (ID_KEY_WORDS.has(lower)) return true;
  if (/[_-](?:id|ids|uuid)$/.test(lower)) return true;
  if (/[a-z0-9](?:Id|ID|Ids|IDs|IDS|Uuid|UUID)$/.test(word)) return true;
  return /(?:^|[_-])(?:account|accounts|zone|zones)(?:[_-]|$)/.test(lower);
}

const SEQUENTIAL_HEX = '0123456789abcdef'.repeat(3);

/**
 * An obvious placeholder: at least half of its hex digits are zeros (an
 * all-zero value, the nil UUID, a mostly-zero test id such as
 * `0190abcd-0000-7000-8000-00000000000a`), one digit repeated, or the run
 * `0123456789abcdef…`. A random identifier is none of these.
 */
export function isPlaceholderIdentifier(value) {
  const hex = value.toLowerCase().replaceAll('-', '');
  const zeros = hex.split('').filter(digit => digit === '0').length;
  if (zeros * 2 >= hex.length) return true;
  if (/^(.)\1*$/.test(hex)) return true;
  return SEQUENTIAL_HEX.includes(hex);
}

/**
 * A cloud identifier: a 32-hex value or a UUID that is not a placeholder, with
 * an identifier key (`isIdentifierKey`) earlier on the same line, whether it
 * is assigned (`account_id = "…"`, `zone_id: …`, `"id": "…"`), passed as a
 * flag (`--account-id …`), part of an API path (`/accounts/…/`) or named in a
 * table row or prose (`| Zone ID | … |`).
 */
export function hasCloudIdentifier(form) {
  // One pass each: a value counts once the first identifier key has ended.
  let keyEnd = -1;
  for (const word of form.matchAll(KEY_WORD)) {
    if (isIdentifierKey(word[0])) {
      keyEnd = word.index + word[0].length;
      break;
    }
  }
  if (keyEnd < 0) return false;
  for (const match of form.matchAll(CLOUD_IDENTIFIER_VALUE)) {
    if (match.index >= keyEnd && !isPlaceholderIdentifier(match[0])) return true;
  }
  return false;
}

const CLOUD_IDENTIFIER_RULE = 'cloud identifier (use a your- placeholder)';

const EMAIL_RULE = 'email address outside the example domains';

function genericRules(allowedAddresses = new Set()) {
  return [
    ['home-directory path', hasHomePath],
    ['Tailscale MagicDNS host', hasTailnetHost],
    [EMAIL_RULE, privateEmailRule(allowedAddresses)],
    ['numbered private host', form => NUMBERED_PRIVATE_HOST.test(form)],
    ['non-placeholder 1Password reference', form => SECRET_REFERENCE.test(form)],
    [
      'single-label https host (use an RFC 2606 name)',
      form => singleLabelHostFindings(form).length > 0,
    ],
    [CLOUD_IDENTIFIER_RULE, hasCloudIdentifier],
  ];
}

const FILE_RULES = genericRules();
const COMMIT_RULES = genericRules(GITHUB_SERVICE_ADDRESSES);
const COMMIT_RULES_WITHOUT_EMAILS = COMMIT_RULES.filter(([rule]) => rule !== EMAIL_RULE);

/** Raised for a setting the check cannot use: it fails rather than guess. */
export class CheckSettingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckSettingError';
  }
}

/** Raised for a terms file that is named but missing, or holds a bad entry. */
export class TermsFileError extends CheckSettingError {
  constructor(message) {
    super(message);
    this.name = 'TermsFileError';
  }
}

/** The values the commit email setting takes; only `noreply` turns it on. */
const COMMIT_EMAIL_MODES = new Set(['noreply']);
const COMMIT_EMAILS_DIRECTIVE = /^commit-emails:(.*)$/i;

/**
 * A terms file's text: its extra terms, each as a rule named by its line in
 * that file (never by the term), and its `commit-emails:` directive
 * (`'noreply'`, or `null` without one). Throws `TermsFileError` for an empty
 * `re:` line, a regular expression that does not compile, or a directive
 * value other than `noreply`, naming the line only.
 */
export function parseTermsFile(text) {
  const rules = [];
  let commitEmails = null;
  text.split('\n').forEach((raw, index) => {
    const entry = raw.trim();
    if (entry === '' || entry.startsWith('#')) return;
    const name = `extra term (terms file line ${index + 1})`;
    const directive = COMMIT_EMAILS_DIRECTIVE.exec(entry);
    if (directive) {
      const value = directive[1].trim().toLowerCase();
      if (!COMMIT_EMAIL_MODES.has(value)) {
        throw new TermsFileError(
          `Public check terms file line ${index + 1}: commit-emails takes the value noreply.`,
        );
      }
      commitEmails = value;
      return;
    }
    if (entry.startsWith('re:')) {
      const source = entry.slice(3);
      let pattern;
      try {
        pattern = new RegExp(source, 'i');
      } catch {
        pattern = undefined;
      }
      if (source === '' || pattern === undefined) {
        throw new TermsFileError(
          `Public check terms file line ${index + 1}: not a valid regular expression.`,
        );
      }
      rules.push([name, form => pattern.test(form)]);
      return;
    }
    const term = entry.toLowerCase();
    rules.push([name, form => form.toLowerCase().includes(term)]);
  });
  return { terms: rules, commitEmails };
}

/** The extra-term rules of a terms file's text (see `parseTermsFile`). */
export function parseExtraTerms(text) {
  return parseTermsFile(text).terms;
}

/**
 * Whether commit emails are checked: `PUBLIC_CHECK_COMMIT_EMAILS=noreply` in
 * `env`, or the terms file's directive. Unset or empty (a CI variable a fork
 * does not define) is off; any other value is an error, never a silent off.
 */
export function commitEmailsChecked(env, termsFile) {
  const value = (env.PUBLIC_CHECK_COMMIT_EMAILS ?? '').trim().toLowerCase();
  if (value !== '' && !COMMIT_EMAIL_MODES.has(value)) {
    throw new CheckSettingError('PUBLIC_CHECK_COMMIT_EMAILS takes the value noreply, or none.');
  }
  return value === 'noreply' || termsFile?.commitEmails === 'noreply';
}

/**
 * Where the terms file is: `PUBLIC_CHECK_TERMS_FILE` when set (resolved from
 * `cwd`), else `public-check-terms.txt` in the clone's common git directory.
 */
export function extraTermsPath({ env = process.env, cwd = process.cwd() } = {}) {
  const named = env.PUBLIC_CHECK_TERMS_FILE;
  if (named !== undefined && named !== '') return { path: resolve(cwd, named), named: true };
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  return { path: resolve(cwd, common, 'public-check-terms.txt'), named: false };
}

/**
 * This clone's terms file (`parseTermsFile`), or `null` when it keeps none. A
 * file named by `PUBLIC_CHECK_TERMS_FILE` must exist: a mistyped name is an
 * error, never a silent pass.
 */
export function loadTermsFile(options = {}) {
  const { path, named } = extraTermsPath(options);
  if (!existsSync(path)) {
    if (named)
      throw new TermsFileError('PUBLIC_CHECK_TERMS_FILE names a file that does not exist.');
    return null;
  }
  return parseTermsFile(readFileSync(path, 'utf8'));
}

/** The extra-term rules for this clone, or `null` when it keeps no terms file. */
export function loadExtraTerms(options = {}) {
  return loadTermsFile(options)?.terms ?? null;
}

/**
 * Every content finding in `text`, as `line N: rule`, in line order. The
 * matched text is never included. `extraTerms` are the rules from a terms
 * file; `identifierAllowed(line)` exempts a line from the cloud-identifier
 * rule; `rules` replaces the file rules (commit messages use their own).
 */
export function contentFindings(
  text,
  { extraTerms = [], identifierAllowed = () => false, rules = FILE_RULES } = {},
) {
  const allRules = [...rules, ...extraTerms];
  const findings = [];
  text.split('\n').forEach((line, index) => {
    const forms = lineForms(line);
    for (const [rule, matches] of allRules) {
      if (rule === CLOUD_IDENTIFIER_RULE && identifierAllowed(line)) continue;
      if (forms.some(form => matches(form))) findings.push(`line ${index + 1}: ${rule}`);
    }
  });
  return findings;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sanitizationFindings(files, root = '.', { extraTerms = [] } = {}) {
  const findings = [];
  for (const file of files) {
    if (FORBIDDEN_PATHS.some(pattern => pattern.test(file))) {
      findings.push(`${file}: forbidden private-only path`);
      continue;
    }
    const buffer = readFileSync(resolve(root, file));
    if (buffer.includes(0)) {
      const pinned = PINNED_BINARY_FILES.get(file);
      if (pinned === undefined) findings.push(`${file}: binary file that is not pinned`);
      else if (sha256(buffer) !== pinned) findings.push(`${file}: binary file unlike its pin`);
      continue;
    }
    const allowances = ALLOWED_IDENTIFIER_LINES.filter(allowance => allowance.file.test(file));
    const identifierAllowed = line => allowances.some(allowance => allowance.line.test(line));
    for (const finding of contentFindings(buffer.toString('utf8'), {
      extraTerms,
      identifierAllowed,
    })) {
      findings.push(`${file}: ${finding}`);
    }
  }
  return findings;
}

/**
 * Single-label `https://` hosts in documentation and tests: the scheme followed
 * by a host with no dot in it (`app`, `a`), plain or in the percent-encoded form
 * a nested-URL example carries.
 *
 * RFC 2606 reserves `.example` (and example.com/net/org) precisely so a written
 * example cannot collide with a real registrable name. A single-label host is
 * not reserved by anything: it reads as an internal hostname to a stranger, and
 * one day it may resolve for somebody. The redaction matrix is full of URL
 * examples, so this is easy to reintroduce by copying a neighbouring line.
 *
 * `localhost` is exempt — it is reserved and means what it says.
 */
const SINGLE_LABEL_HOST = /https(?::\/\/|%3A%2F%2F)([a-z0-9-]+)(?=[/?#'"`\\)\]\s]|%2F|%3F|%23|$)/gi;
const ALLOWED_SINGLE_LABEL_HOSTS = new Set(['localhost']);

export function singleLabelHostFindings(text) {
  const findings = new Set();
  for (const match of text.matchAll(SINGLE_LABEL_HOST)) {
    const host = match[1].toLowerCase();
    if (!ALLOWED_SINGLE_LABEL_HOSTS.has(host)) findings.add(match[0]);
  }
  return [...findings];
}

export function wranglerIdentifierFindings(text) {
  const findings = [];
  text.split('\n').forEach((line, index) => {
    const match = /^\s*(id|preview_id|database_id)\s*=\s*"([^"]+)"/.exec(line);
    if (match && !match[2].startsWith('your-')) {
      findings.push(`wrangler.toml: line ${index + 1}: non-placeholder ${match[1]}`);
    }
  });
  return findings;
}

export function publicCandidateFiles(cwd = process.cwd()) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

// Git drops everything from this line on, so the hook does too (a verbose
// commit's diff follows it). Every other line, comments included, is checked:
// a message given with -F keeps its `#` lines.
const SCISSORS = /^# -+ >8 -+$/m;

/**
 * Findings for one commit message and, with `checkEmails`, its identities,
 * each as `<label>: line N: rule` or `<label>: author email …`, never the text
 * or the address. Without `checkEmails` no email is examined: neither the
 * identities nor an address in the message.
 */
export function commitFindings(
  label,
  { message, authorEmail = '', committerEmail = '' },
  { extraTerms = [], checkEmails = false } = {},
) {
  const cut = SCISSORS.exec(message);
  const text = cut ? message.slice(0, cut.index) : message;
  const rules = checkEmails ? COMMIT_RULES : COMMIT_RULES_WITHOUT_EMAILS;
  const findings = contentFindings(text, { extraTerms, rules }).map(
    finding => `${label}: ${finding}`,
  );
  if (!checkEmails) return findings;
  for (const [role, email] of [
    ['author', authorEmail],
    ['committer', committerEmail],
  ]) {
    if (!identityEmailAllowed(email)) {
      findings.push(`${label}: ${role} email is not a GitHub no-reply or example-domain address`);
    }
  }
  return findings;
}

const ZERO_SHA = /^0+$/;

/**
 * The `git rev-list` arguments for the commits a CI run must check, from the
 * workflow's environment: a pull request's commits (`PR_BASE_SHA..PR_HEAD_SHA`);
 * a push's (`PUSH_BEFORE..GITHUB_SHA`); and for a new branch or tag, a
 * force-push whose old tip was not fetched, or a manual run, the commits not
 * on the default branch (`origin/<DEFAULT_BRANCH>`), or the run's own commit
 * alone when that branch is not there. Never the whole history, which
 * predates the rule. `hasCommit(rev)` says whether a revision is present.
 */
export function ciRevListArgs(env, hasCommit) {
  const head = env.GITHUB_SHA || 'HEAD';
  if (env.EVENT_NAME === 'pull_request') {
    if (!env.PR_BASE_SHA || !env.PR_HEAD_SHA) {
      throw new Error('A pull_request run needs PR_BASE_SHA and PR_HEAD_SHA.');
    }
    return [`${env.PR_BASE_SHA}..${env.PR_HEAD_SHA}`];
  }
  const before = env.PUSH_BEFORE ?? '';
  if (env.EVENT_NAME === 'push' && before !== '' && !ZERO_SHA.test(before) && hasCommit(before)) {
    return [`${before}..${head}`];
  }
  const base = `origin/${env.DEFAULT_BRANCH || 'main'}`;
  if (hasCommit(base)) return [head, '--not', base];
  return ['--max-count=1', head];
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitHasCommit(rev, cwd) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Findings for every commit `git rev-list <revListArgs>` names. */
export function commitRangeFindings(
  revListArgs,
  { cwd = process.cwd(), extraTerms = [], checkEmails = false } = {},
) {
  const shas = git(['rev-list', ...revListArgs], cwd)
    .split('\n')
    .filter(Boolean);
  const findings = [];
  for (const sha of shas) {
    const [authorEmail, committerEmail, message] = git(
      ['show', '-s', '--format=%ae%x00%ce%x00%B', sha],
      cwd,
    ).split('\0');
    findings.push(
      ...commitFindings(
        `commit ${sha.slice(0, 12)}`,
        { message, authorEmail, committerEmail },
        { extraTerms, checkEmails },
      ),
    );
  }
  return { count: shas.length, findings };
}

/** The email of a `git var` identity (`Name <email> time zone`). */
function identityEmail(variable, cwd) {
  return /<([^>]*)>/.exec(git(['var', variable], cwd))?.[1] ?? '';
}

function report(findings, passed) {
  if (findings.length > 0) {
    console.error(`Public sanitization failed:\n${findings.map(item => `- ${item}`).join('\n')}`);
    return 1;
  }
  console.log(passed);
  return 0;
}

function main(argv) {
  const [mode, ...rest] = argv;
  let termsFile;
  let checkEmails;
  try {
    termsFile = loadTermsFile();
    checkEmails = mode === undefined ? false : commitEmailsChecked(process.env, termsFile);
  } catch (error) {
    if (!(error instanceof CheckSettingError)) throw error;
    console.error(error.message);
    return 1;
  }
  if (termsFile === null) console.log('No extra terms file: only the generic rules ran.');
  else console.log(`Extra terms file: ${termsFile.terms.length} terms.`);
  const terms = termsFile?.terms ?? [];
  if (mode !== undefined) {
    console.log(
      checkEmails
        ? 'Commit emails: checked (GitHub no-reply or example-domain addresses).'
        : 'Commit emails: not checked (opt in with PUBLIC_CHECK_COMMIT_EMAILS=noreply).',
    );
  }

  if (mode === undefined) {
    const files = publicCandidateFiles();
    const findings = [
      ...sanitizationFindings(files, '.', { extraTerms: terms }),
      ...wranglerIdentifierFindings(readFileSync('wrangler.toml', 'utf8')),
    ];
    return report(
      findings,
      `Public sanitization passed (${files.length} release-candidate files).`,
    );
  }
  if (mode === '--commit-msg' && rest.length === 1) {
    const findings = commitFindings(
      'commit message',
      {
        message: readFileSync(rest[0], 'utf8'),
        ...(checkEmails && {
          authorEmail: identityEmail('GIT_AUTHOR_IDENT'),
          committerEmail: identityEmail('GIT_COMMITTER_IDENT'),
        }),
      },
      { extraTerms: terms, checkEmails },
    );
    return report(findings, 'Public sanitization passed (commit message).');
  }
  if ((mode === '--commits' && rest.length > 0) || (mode === '--ci-commits' && rest.length === 0)) {
    const revListArgs =
      mode === '--commits' ? rest : ciRevListArgs(process.env, rev => gitHasCommit(rev));
    const { count, findings } = commitRangeFindings(revListArgs, {
      extraTerms: terms,
      checkEmails,
    });
    return report(findings, `Public sanitization passed (${count} commits).`);
  }
  console.error(
    'Usage: check-public-sanitization.mjs [--commit-msg <file> | --commits <rev-list args> | --ci-commits]',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
