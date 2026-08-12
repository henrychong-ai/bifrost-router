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
  }
  return findings;
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
