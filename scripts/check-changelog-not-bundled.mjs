#!/usr/bin/env node
/**
 * Fail the build if the engineering changelog is inside the dashboard bundle.
 *
 * The changelog page used to do
 * `import changelogRaw from '../../../CHANGELOG.md?raw'`, which compiled the
 * whole document into a JS chunk under `/assets`. Those assets are served by
 * nginx with no credential check, so every release note was readable by anyone
 * who could reach the dashboard host.
 *
 * The changelog now comes from the authenticated `GET /api/changelog` route.
 * This gate exists so a future `?raw` re-import cannot silently republish it:
 * it scans every emitted file under `admin/dist` for a release heading and
 * exits non-zero if it finds one.
 *
 * The heading is matched in BOTH forms — as a real line, and as the `\n`-escaped
 * text a bundler produces when it inlines markdown into a JS string literal.
 * Matching only real newlines would miss the exact regression this guards.
 *
 * Usage:
 *   node scripts/check-changelog-not-bundled.mjs
 *   node scripts/check-changelog-not-bundled.mjs --dir <path>   # tests/fixtures
 */

import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Release headings found in `text`, in both the literal and the escaped form.
 * Deliberately anchored on `## v<major>.<minor>.<patch> (` — a literal-digit
 * version followed by the date's opening bracket — so the changelog parser's
 * own SOURCE regex (`/^## v([\d.]+)…`) can never trip it.
 */
export function findChangelogHeadings(text) {
  const normalised = text.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n');
  return [...normalised.matchAll(/^## v\d+\.\d+\.\d+ \(/gm)].map(match => match[0].trim());
}

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
 * Scan a built dashboard directory. Returns the offenders AND the number of
 * files examined, because "no offenders" is only meaningful if something was
 * actually scanned — an empty or wrong directory would otherwise pass
 * vacuously and retire the gate silently.
 */
export async function scanDirectory(directory) {
  const offenders = [];
  const files = await listFiles(directory);
  for (const path of files) {
    // Binary assets decode to mojibake rather than throwing; a release heading
    // cannot survive that, so a lossy read is safe and keeps the scan total.
    const headings = findChangelogHeadings(await readFile(path, 'utf8'));
    if (headings.length > 0) {
      offenders.push({ path, headings: headings.slice(0, 3), total: headings.length });
    }
  }
  // ⚠️ The entry point must be at the ROOT of the scanned directory: a tree
  // holding only `nested/index.html` is not the dashboard build, and accepting
  // it would let the gate pass against the wrong directory.
  return {
    offenders,
    scanned: files.length,
    hasIndex: files.includes(resolve(directory, 'index.html')),
  };
}

/** CLI entry point — resolves the target directory, reports, and sets the code. */
async function main(argv) {
  const dirFlag = argv.indexOf('--dir');
  if (dirFlag !== -1 && !argv[dirFlag + 1]) {
    // A bare `--dir` used to resolve to the CURRENT directory and scan the repo.
    console.error('✗ --dir requires a directory path.');
    return 1;
  }
  const target = dirFlag === -1 ? resolve(repoRoot, 'admin/dist') : resolve(argv[dirFlag + 1]);

  let result;
  try {
    result = await scanDirectory(target);
  } catch (error) {
    // Fail CLOSED: an unreadable or missing build directory is not a pass.
    console.error(`✗ Changelog bundle gate could not scan ${target}: ${error.message}`);
    return 1;
  }

  const { offenders, scanned, hasIndex } = result;

  // A pass has to mean something was examined. An empty directory, or one that
  // is not a dashboard build, would otherwise report success for ever.
  if (scanned === 0) {
    console.error(`✗ Changelog bundle gate scanned 0 files under ${target}.`);
    return 1;
  }
  if (!hasIndex) {
    console.error(
      `✗ Changelog bundle gate found no index.html at the ROOT of ${target} ` +
        `(${scanned} file(s) scanned) — this does not look like a dashboard build.`,
    );
    return 1;
  }

  if (offenders.length > 0) {
    console.error(
      `\n✗ The changelog is inside the dashboard bundle — ${offenders.length} file(s) under ` +
        `${relative(repoRoot, target) || target} carry a release heading:\n`,
    );
    for (const offender of offenders) {
      console.error(
        `    ${relative(target, offender.path)} — ${offender.total} heading(s), e.g. ${offender.headings.join(', ')}`,
      );
    }
    console.error(
      '\nThe built dashboard assets are served with no credential check, so this\n' +
        'publishes every release note to anyone who can reach the dashboard host.\n' +
        'Fetch the changelog from GET /api/changelog instead of importing\n' +
        'CHANGELOG.md into the SPA.\n',
    );
    return 1;
  }

  console.log(
    `✓ No changelog release heading in ${scanned} file(s) under ` +
      `${relative(repoRoot, target) || target}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv);
}
