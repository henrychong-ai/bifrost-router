/**
 * Free-text comment / note contract for R2 files.
 *
 * A single, editable, plain-text note attached to an R2 file. This module is
 * the single source of truth shared by the Worker backend (validation +
 * persistence) and the admin dashboard (input validation + counter) so both
 * agree on the limit, the sanitisation rules, and the empty-clears semantics.
 *
 * Design notes:
 * - Multi-line is allowed (this is an internal ops note, unlike Cloudflare DNS
 *   record comments which are single-line). `\n` and `\t` are preserved; all
 *   other control characters are stripped.
 * - Plain text only — never rendered as HTML/markdown (the dashboard relies on
 *   React's default escaping). Sanitising on write is defence-in-depth.
 * - Empty / whitespace-only input clears the comment (returns null).
 */

import { z } from 'zod';

/**
 * Maximum comment length in characters. Roomier than Cloudflare DNS's 500-char
 * cap to accommodate multi-line operational notes, while staying far below any
 * KV (25 MB value) or D1 (TEXT) storage limit.
 */
export const COMMENT_MAX_LENGTH = 1000;

/**
 * Strip C0 control characters and DEL from a string, preserving tab (\t) and
 * newline (\n). Implemented as a code-point filter rather than a control-char
 * regex literal so the source stays free of control characters (lint-clean).
 */
function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10) {
      // tab or newline — keep
      out += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      // other C0 control or DEL — drop
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Sanitise a free-text comment.
 *
 * Normalises line endings (CRLF / CR → LF), strips control characters except
 * tab and newline, trims surrounding whitespace, and clamps to
 * {@link COMMENT_MAX_LENGTH} as a defence-in-depth backstop (validation should
 * reject over-length input first). Returns `null` for empty / whitespace-only /
 * nullish input, which callers treat as "clear the comment".
 */
export function sanitizeComment(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const normalisedNewlines = raw.replace(/\r\n?/g, '\n');
  const trimmed = stripControlChars(normalisedNewlines).trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > COMMENT_MAX_LENGTH ? trimmed.slice(0, COMMENT_MAX_LENGTH) : trimmed;
}

/**
 * True when the raw input sanitises to nothing (i.e. the caller should clear
 * any stored comment rather than persist an empty string).
 */
export function isCommentEmpty(raw: string | null | undefined): boolean {
  return sanitizeComment(raw) === null;
}

/**
 * Length-bounded comment string schema. Compose with `.nullable().optional()`
 * at the call site (or use {@link CommentFieldSchema}) so that omitting the
 * field leaves an existing comment untouched and an explicit `null`/empty
 * clears it.
 */
export const CommentSchema = z
  .string()
  .max(COMMENT_MAX_LENGTH, `Comment must be ${COMMENT_MAX_LENGTH} characters or fewer`);

/**
 * Optional + nullable comment field for request bodies (files).
 */
export const CommentFieldSchema = CommentSchema.nullable().optional();
