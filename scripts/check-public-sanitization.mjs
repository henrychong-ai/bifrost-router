#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORBIDDEN_PATHS = [
  /(^|\/)\.claude\//,
  /(^|\/)\.dev\.vars(?:\.|$)/,
  /(^|\/)plans\//,
  /(^|\/)security-reports\//,
];

const FORBIDDEN_CONTENT = [
  /\/Users\/henrychong\//i,
  /\bbifrost-hc\b/i,
  /\brepos-fusang\b/i,
  /\bvps-\d+\b/i,
  /chimera-basilisk/i,
  /parrot-lizard/i,
  /henry\.chong@fusang\.co/i,
  /(?:henrychong|davidchong|vanessahung)\.(?:com|co|net)/i,
  /\bop:\/\/(?!your-(?:vault|1password)\b)/i,
  /(?:link|bifrost|private|sites)\.fusang\.co/i,
  /\bfusang\.tv\b/i,
];

const SCANNER_DEFINITION_FILES = new Set([
  'scripts/check-public-sanitization.mjs',
  'scripts/check-public-sanitization.test.mjs',
]);

export function sanitizationFindings(files) {
  const findings = [];
  for (const file of files) {
    if (FORBIDDEN_PATHS.some(pattern => pattern.test(file))) {
      findings.push(`${file}: forbidden private-only path`);
      continue;
    }
    if (SCANNER_DEFINITION_FILES.has(file)) continue;
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    for (const pattern of FORBIDDEN_CONTENT) {
      if (pattern.test(text)) findings.push(`${file}: contains ${pattern}`);
    }
    for (const host of singleLabelHostFindings(text)) {
      findings.push(`${file}: single-label example host ${host} (use an RFC 2606 name)`);
    }
  }
  return findings;
}

/**
 * Single-label `https://` hosts in documentation and tests — `https://app/`,
 * `https://a/b`, and the percent-encoded `https%3A%2F%2Fapp%3F` form.
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
  for (const match of text.matchAll(/^\s*(?:id|preview_id|database_id)\s*=\s*"([^"]+)"/gm)) {
    const value = match[1];
    if (!value.startsWith('your-'))
      findings.push(`wrangler.toml: non-placeholder identifier ${value}`);
  }
  return findings;
}

export function publicCandidateFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
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
