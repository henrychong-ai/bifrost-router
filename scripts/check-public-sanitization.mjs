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
 * Two kinds of rule:
 *
 * 1. Generic rules, which need no identifier at all:
 *    - a home-directory path, with or without a trailing separator: a macOS
 *      `Users` directory (capital U, matched anywhere, so under a volume or
 *      WSL mount and in a source map too; the `Shared` directory is allowed),
 *      a Windows drive's `Users` directory with either slash (the profile name
 *      may contain spaces), or a Linux `home` or `var/home` directory (the
 *      `node` and `runner` container and CI users are allowed). A lower-case
 *      `users` segment is an application route and is not flagged, and a
 *      name in angle brackets is a placeholder;
 *    - a Tailscale MagicDNS host (anything under `ts.net`), unless its tailnet
 *      label is a `your-` placeholder;
 *    - an email address, unless its domain is an RFC 2606 example domain
 *      (example.com, example.org, example.net or a subdomain of one, or any
 *      `.example` name) or the GitHub no-reply domain. An scp-style git remote
 *      and a `name@2x.png`-style asset name are not addresses, and neither is
 *      a version pin, whose top-level label is not alphabetic;
 *    - a 1Password secret reference that is not a `your-vault` /
 *      `your-1password` placeholder;
 *    - a numbered private host name of the `vps-` form;
 *    - a single-label `https://` host (see `singleLabelHostFindings`).
 *
 * 2. Hashed rules, for the specific private names a generic rule cannot
 *    describe: tailnet names, a private repository and directory name,
 *    personal site domains and private company hosts. Only the SHA-256 of
 *    `${IDENTIFIER_SALT}:${identifier}` is stored.
 *
 *    This is forward-only concealment, not secrecy. The earlier plain-text
 *    list is still in this repository's public history (from 2026-08-12), and
 *    the salt is public, so anyone can guess a candidate value and confirm it
 *    by hashing it the same way. What hashing changes is that the current
 *    file no longer prints the list.
 *
 *    Matching: each form is lower-cased and split into tokens, the maximal
 *    runs of `[a-z0-9.-]`. Every run of up to MAX_IDENTIFIER_PARTS consecutive
 *    dot- or hyphen-separated parts of a token is hashed and looked up. A
 *    hashed name therefore matches as a subdomain of something longer, inside
 *    a longer hyphenated name, in a URL, path or email address, and in any
 *    letter case. A glued form, the name with extra letters or digits fused
 *    straight onto it, is intentionally not matched.
 *
 *    To add an identifier: it must consist only of `[a-z0-9.-]` once
 *    lower-cased, or it can never match. Compute its digest locally and add
 *    only the digest to PRIVATE_IDENTIFIER_DIGESTS (keep the list sorted).
 *    Never commit the plain value, in code, a test, a comment or a commit
 *    message. With a placeholder standing in for the real value:
 *
 *      node -e "console.log(require('node:crypto').createHash('sha256').update('bifrost-public-check-v1:' + process.argv[1].toLowerCase()).digest('hex'))" 'your-identifier.example'
 *
 *    An identifier may have at most MAX_IDENTIFIER_PARTS parts; raise it
 *    before adding a longer one. The test asserts the list's size, so update
 *    that count in the same commit.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN_PATHS = [
  /(^|\/)\.claude\//,
  /(^|\/)\.dev\.vars(?:\.|$)/,
  /(^|\/)plans\//,
  /(^|\/)security-reports\//,
];

export const IDENTIFIER_SALT = 'bifrost-public-check-v1';
export const MAX_IDENTIFIER_PARTS = 4;

export const PRIVATE_IDENTIFIER_DIGESTS = new Set([
  '004d767a7fa2cda15b840dee87027673e1d6e5861a570b364c83bf07d75c6de5',
  '1807f3fc6eb119c0dd90c45851a0b24110e6cc5b544951fe3a99919ba24150e6',
  '340bb295ed3658cbb375b88f721319b45ca4df857186332c828525482affe913',
  '48a7bcbe8f444233a85c1cd474dbbd8f06a56389bea71cf71f838762366e3e74',
  '5986053701c5b1eae3b228435a3f9c41d059c5459a0014e49d35b52beba86172',
  '5c67f8482c8cdf53cc9fcd0411c62738b5c9c7bb6ce84fac37e5f23007c5c3a0',
  '720fe06504679c22218e676b81cbca8348d7ab1d92af8cffa5971c89b53986a8',
  '78f5eac0fdf4fc522f1ba15f35c0e5f8f83429a7154d2ac360c13ac4065df0b6',
  '7f862e5dcc53dc38dead72a04d5c1e1fdace129ff89e78aa80c8dcfb34efe307',
  '7fdf18b1577b8ebb16d728e10334a8e591b3f8dd38461fe224370e59afdb8682',
  '8cec9902c757d6fcd095f9502796a56773118e35bb3bcc08aaba87e3975026cf',
  '90bd626f0863819b3bed0edcf3d6264d1a4b1c84e8a285efe6a1778fddbaff21',
  'a0b16aff3268cdcd2e6812348ec551b9d9755766fa992a58da518dc34cb79670',
  'a130c41c07d1a94a24417926a936969dfeb18ec89e0c9189a83b5c31713af582',
  'a3dc970e81582a389ecf31241198b51279621ef5458de5ba803742ea5fea71fb',
  'a7261b35e623e91fbe91d01d9aacbee0428fdbf6883750d6d51ab909d250d637',
  'c621c0957c5a11ef891670ce5230183414a783f59c8ac6c62b6456ef4f78295a',
  'd1b0354ec10aea50c20bf587f2f9d11d7a16bd20f57a7404574292823bc0e51d',
  'dbe09dc94a2d7b4e0328d0eea0492c7b497dde9f790da022a4dd20e7fcff367d',
  'e1b88758f8781050b890b0cca8ee76ff409cc67a4178c87843b1e132c483a284',
  'e7387c84a00a1c28218bfe2380e4060f566117419bb945037ffe57d5678fb57a',
  'f8a64161daf80d1479f16eb7d96ccbf384b847b0018c1c08da541187e6a72905',
]);

export function identifierDigest(salt, identifier) {
  return createHash('sha256').update(`${salt}:${identifier}`).digest('hex');
}

const IDENTIFIER_TOKEN = /[a-z0-9.-]+/g;

function tokensOf(text) {
  return text.toLowerCase().match(IDENTIFIER_TOKEN) ?? [];
}

/**
 * Returns a predicate that is true when a text holds a hashed identifier.
 * `salt` and `digests` are parameters so a test can inject a synthetic set;
 * the shipped set is the default.
 */
export function createIdentifierMatcher({
  salt = IDENTIFIER_SALT,
  digests = PRIVATE_IDENTIFIER_DIGESTS,
  maxParts = MAX_IDENTIFIER_PARTS,
} = {}) {
  const tokenVerdicts = new Map();
  const candidateVerdicts = new Map();

  const isPrivate = candidate => {
    let verdict = candidateVerdicts.get(candidate);
    if (verdict === undefined) {
      verdict = digests.has(identifierDigest(salt, candidate));
      candidateVerdicts.set(candidate, verdict);
    }
    return verdict;
  };

  const tokenIsPrivate = token => {
    // Even indexes are parts, odd indexes the delimiter between two parts.
    const pieces = token.split(/([.-])/);
    for (let start = 0; start < pieces.length; start += 2) {
      let candidate = pieces[start];
      for (let end = start; end < pieces.length && end < start + 2 * maxParts; end += 2) {
        if (end > start) candidate += pieces[end - 1] + pieces[end];
        if (pieces[end] !== '' && isPrivate(candidate)) return true;
      }
    }
    return false;
  };

  return text =>
    tokensOf(text).some(token => {
      let verdict = tokenVerdicts.get(token);
      if (verdict === undefined) {
        verdict = tokenIsPrivate(token);
        tokenVerdicts.set(token, verdict);
      }
      return verdict;
    });
}

const defaultIdentifierMatcher = createIdentifierMatcher();

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
// `icon@2x.png`, `logo@1.5x.webp`: a resolution suffix, not a domain.
const ASSET_SCALE_SUFFIX = /^\d+(?:\.\d+)?x\.[a-z0-9]+$/;

function hasPrivateEmail(form) {
  for (const match of form.matchAll(EMAIL_ADDRESS)) {
    const local = match[1].toLowerCase();
    const domain = match[2].toLowerCase();
    const next = form[match.index + match[0].length];
    if (local === 'git' && (next === ':' || next === '/')) continue;
    if (ASSET_SCALE_SUFFIX.test(domain)) continue;
    if (EXAMPLE_EMAIL_DOMAIN.test(domain) || ALLOWED_EMAIL_DOMAINS.has(domain)) continue;
    return true;
  }
  return false;
}

const NUMBERED_PRIVATE_HOST = /\bvps-\d+\b/i;
const SECRET_REFERENCE = /\bop:[/][/](?!your-(?:vault|1password)\b)/i;

const GENERIC_RULES = [
  ['home-directory path', hasHomePath],
  ['Tailscale MagicDNS host', hasTailnetHost],
  ['email address outside the example domains', hasPrivateEmail],
  ['numbered private host', form => NUMBERED_PRIVATE_HOST.test(form)],
  ['non-placeholder 1Password reference', form => SECRET_REFERENCE.test(form)],
  [
    'single-label https host (use an RFC 2606 name)',
    form => singleLabelHostFindings(form).length > 0,
  ],
];

/**
 * Every content finding in `text`, as `line N: rule`, in line order. The
 * matched text is never included.
 */
export function contentFindings(text, identifierMatcher = defaultIdentifierMatcher) {
  const rules = [...GENERIC_RULES, ['hashed private identifier', identifierMatcher]];
  const findings = [];
  text.split('\n').forEach((line, index) => {
    const forms = lineForms(line);
    for (const [rule, matches] of rules) {
      if (forms.some(form => matches(form))) findings.push(`line ${index + 1}: ${rule}`);
    }
  });
  return findings;
}

export function sanitizationFindings(files, root = '.') {
  const findings = [];
  for (const file of files) {
    if (FORBIDDEN_PATHS.some(pattern => pattern.test(file))) {
      findings.push(`${file}: forbidden private-only path`);
      continue;
    }
    const buffer = readFileSync(resolve(root, file));
    if (buffer.includes(0)) continue;
    for (const finding of contentFindings(buffer.toString('utf8'))) {
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const files = publicCandidateFiles();
  const findings = [
    ...sanitizationFindings(files),
    ...wranglerIdentifierFindings(readFileSync('wrangler.toml', 'utf8')),
  ];
  if (findings.length > 0) {
    console.error(`Public sanitization failed:\n${findings.map(item => `- ${item}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Public sanitization passed (${files.length} release-candidate files).`);
}
