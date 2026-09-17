#!/usr/bin/env node
/**
 * Generate `src/generated/changelog-text.ts` from `CHANGELOG.md`.
 *
 * WHY A GENERATED MODULE AND NOT A TEXT IMPORT. The Worker serves the
 * changelog from an authenticated route, so the markdown has to reach the
 * Worker bundle. Wrangler can do that with a `[[rules]] type = "Text"` entry —
 * but the vitest Workers pool transforms the same `src/index.ts` graph with
 * vite, which parses a `.md` specifier as JavaScript and fails on the first
 * heading. A `.ts` module is understood by every toolchain that reads this
 * graph, so the markdown is checked in as one string literal instead.
 *
 * The emitted file is a build artefact: it is not formatted, not linted, and
 * its single-line diff is not meant to be read. `--check` proves it matches
 * CHANGELOG.md and runs inside `pnpm run check`.
 *
 * Usage:
 *   node scripts/generate-changelog-module.mjs            # write
 *   node scripts/generate-changelog-module.mjs --check    # verify only
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = resolve(repoRoot, 'CHANGELOG.md');
const OUTPUT_PATH = resolve(repoRoot, 'src/generated/changelog-text.ts');

/**
 * The module source for a given markdown body. Pure, so the gate test can
 * compare rendered output without touching the filesystem.
 */
export function renderChangelogModule(markdown) {
  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source: CHANGELOG.md · Generator: scripts/generate-changelog-module.mjs',
    '// Regenerate with `pnpm run changelog:generate` after ANY CHANGELOG.md edit;',
    '// `pnpm run check` fails while this file is stale.',
    '//',
    '// The changelog is served ONLY from the authenticated `GET /api/changelog`',
    '// route. It must never be imported into the dashboard SPA bundle again —',
    '// the built assets are served with no credential check, which published the',
    '// whole engineering changelog to anyone who could reach the dashboard host.',
    '// `pnpm run check:changelog-bundle` fails the build if a release heading',
    '// reappears under admin/dist.',
    'export const CHANGELOG_MARKDOWN =',
    `  ${JSON.stringify(markdown)};`,
    '',
  ].join('\n');
}

const markdown = readFileSync(SOURCE_PATH, 'utf8');
const expected = renderChangelogModule(markdown);

if (process.argv.includes('--check')) {
  let actual = null;
  try {
    actual = readFileSync(OUTPUT_PATH, 'utf8');
  } catch {
    actual = null;
  }
  if (actual !== expected) {
    console.error(
      `\n✗ src/generated/changelog-text.ts is ${actual === null ? 'missing' : 'stale'}.\n` +
        '  CHANGELOG.md changed without regenerating the module the Worker serves.\n' +
        '  Fix: pnpm run changelog:generate\n',
    );
    process.exit(1);
  }
  console.log('✓ src/generated/changelog-text.ts matches CHANGELOG.md');
} else {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected);
  console.log(
    `✓ wrote src/generated/changelog-text.ts (${markdown.length.toLocaleString()} markdown characters)`,
  );
}
