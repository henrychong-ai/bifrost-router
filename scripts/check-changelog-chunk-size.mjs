#!/usr/bin/env node
/**
 * Cap the dashboard's changelog route chunk.
 *
 * This is a SECURITY tripwire as much as a size one. The changelog markdown is
 * not imported into the bundle — the page fetches it from the authenticated
 * `GET /api/changelog` — so this chunk is just the React route. A jump past the
 * ceiling means the changelog has been bundled again, i.e. the whole
 * engineering changelog is being served from `/assets/*`, which carries no
 * credential check. `pnpm run check:changelog-bundle` is the direct assertion
 * on the text; this is the cheap tripwire beside it, and it also catches a
 * partial re-import that the heading scan happens to miss.
 *
 * Deliberately ONE budget, not a whole-bundle one: this template ships no
 * approved application-code baseline, and inventing one here would either fire
 * on ordinary feature work or quietly absorb a real regression.
 *
 * Identification FAILS CLOSED: zero matches or more than one is a hard error. A
 * silent mismatch would be worse than no gate at all — the changelog text could
 * grow unmeasured under a chunk name the pattern no longer recognises.
 *
 * Usage:
 *   node scripts/check-changelog-chunk-size.mjs
 *   node scripts/check-changelog-chunk-size.mjs --dir <path>   # tests/fixtures
 */

import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Page code only. Measured at roughly 2.3 KB gzipped; the ceiling leaves ample
 * room for the route to grow while staying far below the ~30 KB the markdown
 * itself costs. Changing it is an explicit budget decision, never an automatic
 * rebaseline.
 */
export const CHANGELOG_CHUNK_MAX_GZIP_BYTES = 32_768;

/**
 * The emitted changelog route chunk, produced by the route-level dynamic
 * import. Vite content-hashes the name, so match the stable prefix.
 */
export const CHANGELOG_CHUNK_PATTERN = /^assets\/changelog-[^/]+\.js$/;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Measure the changelog chunk under `directory`. Returns the matching file's
 * deterministic gzip size, or the reason it could not be measured.
 */
export async function measureChangelogChunk(directory) {
  const paths = await listFiles(directory);
  const matches = paths
    .map(path => relative(directory, path).replaceAll('\\', '/'))
    .filter(path => CHANGELOG_CHUNK_PATTERN.test(path));

  if (matches.length !== 1) {
    return { matches, gzipBytes: null };
  }

  const contents = await readFile(resolve(directory, matches[0]));
  return {
    matches,
    // Node's zero-mtime gzip stream is deterministic across build timestamps.
    gzipBytes: gzipSync(contents, { level: 6 }).byteLength,
  };
}

async function main(argv) {
  const dirFlag = argv.indexOf('--dir');
  if (dirFlag !== -1 && !argv[dirFlag + 1]) {
    console.error('✗ --dir requires a directory path.');
    return 1;
  }
  const target = dirFlag === -1 ? resolve(repoRoot, 'admin/dist') : resolve(argv[dirFlag + 1]);

  let result;
  try {
    result = await measureChangelogChunk(target);
  } catch (error) {
    // Fail CLOSED: an unreadable or missing build directory is not a pass.
    console.error(`✗ Changelog chunk gate could not scan ${target}: ${error.message}`);
    return 1;
  }

  const { matches, gzipBytes } = result;
  if (gzipBytes === null) {
    console.error(
      `✗ Changelog chunk gate expected exactly 1 chunk matching ${CHANGELOG_CHUNK_PATTERN}, ` +
        `found ${matches.length}${matches.length ? `: ${matches.join(', ')}` : ''}. ` +
        'The budget cannot be applied until the pattern matches the emitted chunk.',
    );
    return 1;
  }

  if (gzipBytes > CHANGELOG_CHUNK_MAX_GZIP_BYTES) {
    console.error(
      `\n✗ Changelog chunk is ${gzipBytes.toLocaleString()} deterministic gzip bytes, ` +
        `over the ${CHANGELOG_CHUNK_MAX_GZIP_BYTES.toLocaleString()} ceiling (${matches[0]}).\n\n` +
        'This usually means CHANGELOG.md has been imported into the SPA again, which\n' +
        'publishes every release note from /assets/* with no credential check. Fetch it\n' +
        'from GET /api/changelog instead.\n',
    );
    return 1;
  }

  console.log(
    `✓ Changelog chunk: ${gzipBytes.toLocaleString()} deterministic gzip bytes ` +
      `(limit ${CHANGELOG_CHUNK_MAX_GZIP_BYTES.toLocaleString()}, ${matches[0]})`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv);
}
