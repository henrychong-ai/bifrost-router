/**
 * R2 object-key normalization (v1.27.0) — lowercase + kebab-case, per segment.
 *
 * Shared by the worker (write-time enforcement at new-key sites, flag-gated by
 * `R2_KEY_NORMALIZE`) and the dashboard (clean-default auto-fill + live "Saved
 * as: …" preview), so both produce byte-identical keys — no drift.
 *
 * **Why.** R2 keys are case-SENSITIVE (`Report.pdf` ≠ `report.pdf`), which is a
 * footgun for a public link/asset host (a route target typed with the wrong
 * case 404s), and spaces/specials become `%20`-style URL noise. Routes already
 * lowercase their paths; this brings storage keys in line.
 *
 * **Algorithm (per path SEGMENT — `/` is preserved as the subdir separator):**
 *  - lowercase
 *  - replace every char that is NOT `[a-z0-9._-]` (whitespace + URL-noisy
 *    specials) with `-`
 *  - tidy `-`/`.` adjacency, collapse repeats, trim leading/trailing `-`/`.`
 *
 * The extension dot and interior dots are preserved (legit in `archive.tar.gz`).
 * Accented Latin is transliterated to ASCII (NFKD + strip combining marks):
 * `café` → `cafe`, `résumé` → `resume`. Dangerous patterns (`..`, control chars,
 * Windows-illegal, dotfiles, leading `/`) are NOT this function's job — they
 * remain hard REJECTs in `validateR2Key` (security pre-gate), which runs BEFORE
 * normalization.
 *
 * **Non-Latin limitation (documented):** scripts with no ASCII decomposition
 * (CJK, Cyrillic, emoji, …) have no readable transliteration, so a non-Latin
 * basename collapses to its extension (`報告.pdf` → `pdf`). This is lossy but
 * SAFE: a resulting collision surfaces as the existing 409 (never a silent
 * overwrite), and the dashboard's live "Saved as: …" preview shows the result
 * before submit. If a key normalizes to empty (e.g. `---`), `validateR2Key`
 * rejects it. Operators needing verbatim non-Latin keys disable
 * `R2_KEY_NORMALIZE`.
 *
 * **Idempotent:** `normalizeR2Key(normalizeR2Key(k)) === normalizeR2Key(k)`.
 */

import { trimEndChars, trimStartChars } from './trim-chars.js';

/** Normalize a single path segment (no `/`). */
function normalizeSegment(segment: string): string {
  const kebab = segment
    // Transliterate accented Latin to ASCII so European filenames stay
    // readable: `café` → `cafe`, `résumé` → `resume`, `Übersicht` → `ubersicht`
    // (NFKD splits the base letter from its combining mark, which we then
    // strip). Non-Latin scripts (CJK, etc.) have no ASCII decomposition and
    // fall through to the `-` rule below — see the module note on that limit.
    // Safe: this runs per-segment AFTER `split('/')`, and the rules below
    // re-collapse any ASCII `.`/`/` a fullwidth char might decompose to, so it
    // cannot synthesise `..`, a leading `.`, or a path separator.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-'); // whitespace + URL-noisy specials → '-'
  // a '.' (optionally wrapped in '-') → a clean '.'; then repeated '-' and
  // '.' collapsed; then leading/trailing '-' and '.' trimmed. Linear scans
  // (v1.39.0), not the polynomial `/-*\.-*/g` and `/^[-.]+|[-.]+$/g`.
  const collapsed = dropDashesAroundDots(kebab).replace(/-+/g, '-').replace(/\.+/g, '.');
  return trimEndChars(trimStartChars(collapsed, '-.'), '-.');
}

/**
 * `value` with every run of `-` that touches a `.` removed (`a-.-b` →
 * `a.b`), in one pass: the same result as replacing every match of the
 * global regex `-*\.-*` with `.`, which code scanning flags as polynomial (a
 * long run of `-` with no `.` is retried from each of its characters).
 * Exported for its equality test.
 */
export function dropDashesAroundDots(value: string): string {
  let out = '';
  let index = 0;
  while (index < value.length) {
    if (value.charAt(index) !== '-') {
      out += value.charAt(index);
      index += 1;
      continue;
    }
    let end = index;
    while (end < value.length && value.charAt(end) === '-') end += 1;
    const touchesDot = value.charAt(index - 1) === '.' || value.charAt(end) === '.';
    if (!touchesDot) out += value.slice(index, end);
    index = end;
  }
  return out;
}

/**
 * Normalize a full R2 object key to lowercase-kebab, preserving `/` subdir
 * structure. Empty segments (from `//` or leading/trailing `/`) are dropped.
 */
export function normalizeR2Key(key: string): string {
  return key
    .split('/')
    .map(normalizeSegment)
    .filter(segment => segment.length > 0)
    .join('/');
}

/** True when `key` is already in normalized form (no transform would change it). */
export function isNormalizedR2Key(key: string): boolean {
  return normalizeR2Key(key) === key;
}

/**
 * `value` without its trailing `/` characters, in one backward scan (v1.39.0).
 * The same result as `value.replace(/\/+$/, '')`, which code scanning flags
 * as polynomial: on a long run of `/` that does not end the string, it tries
 * the run again from every starting slash (50,000 slashes and a letter took a
 * second).
 */
export function trimTrailingSlashes(value: string): string {
  return trimEndChars(value, '/');
}

/**
 * The key an R2 route can serve (moved here from the Worker's
 * `path-validation.ts`, v1.38.0, so the dashboard checks a route target with
 * the Worker's own rule): control characters, Windows-illegal characters,
 * `..`, a leading `/`, empty segments and dot-prefixed (hidden) segments are
 * stripped or collapsed. The Worker's `validateR2Key` refuses any key this
 * changes; it never serves the sanitised form.
 */
export function sanitizeR2Key(key: string): string {
  let sanitized = key;
  /* eslint-disable no-control-regex */
  sanitized = sanitized.replace(/\x00/g, '');
  sanitized = sanitized.replace(/[\x00-\x1f]/g, '');
  /* eslint-enable no-control-regex */
  sanitized = sanitized.replace(/[<>:"|?*]/g, '');
  sanitized = sanitized.replace(/\\/g, '/');
  while (sanitized.includes('..')) {
    sanitized = sanitized.replace(/\.\./g, '');
  }
  sanitized = sanitized.replace(/^\/+/, '');
  sanitized = sanitized.replace(/\/+/g, '/');
  sanitized = trimTrailingSlashes(sanitized);
  sanitized = sanitized.replace(/(?:^|\/)\.(?!\.)[^/]*/g, '');
  sanitized = sanitized.replace(/^\/+/, '');
  sanitized = sanitized.replace(/\/+/g, '/');
  sanitized = trimTrailingSlashes(sanitized);
  return sanitized;
}

/**
 * Whether `key` is an R2 object key an R2 route can serve as it is: not
 * blank, and unchanged by {@link sanitizeR2Key} (the rule the Worker's
 * `validateR2Key` applies before it reads R2). A URL (`https://…`) is not one.
 */
export function isServableR2Key(key: string): boolean {
  return key.trim() !== '' && sanitizeR2Key(key) === key;
}
