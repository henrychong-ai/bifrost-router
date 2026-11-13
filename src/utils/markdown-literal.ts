/**
 * Write untrusted text into a Markdown document as a code literal.
 *
 * The feedback Markdown export is read by administrators and by AI triage
 * agents. Submitted and triage text must show there exactly as typed and must
 * never become Markdown structure (a heading, a forged item, a link, an image,
 * raw HTML). So every free-text value appears only inside a code literal:
 * an inline code span for a single-line value, a fenced code block for a
 * multi-line one. CommonMark renders the content of both verbatim.
 *
 * The one way out of a code literal is its own closing delimiter, so each
 * delimiter is a backtick run longer than any backtick run in the value: a code
 * span closes only on a run of exactly its length, and a fence closes only on
 * a line holding at least as many backticks as it opened with.
 */

/** Every line break a renderer may honour, for a value that must stay on one line. */
const INLINE_LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/g;

/** Line endings normalised to LF for a fenced block (CommonMark also ends a line at a bare CR). */
const BLOCK_LINE_BREAK = /\r\n?|[\u2028\u2029]/g;

/** The length of the longest run of consecutive backticks in `text` (0 if none). */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * A multi-line value as a fenced code block with the info string `text`.
 * Place it at the top level of the document, after a blank line, so no
 * container block can end it early.
 */
export function fenceMarkdownText(text: string): string {
  const value = text.replace(BLOCK_LINE_BREAK, '\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(value) + 1));
  return `${fence}text\n${value}\n${fence}`;
}

/**
 * A single-line value as an inline code span, safe on a heading or list line.
 * Line breaks become spaces (a code span cannot hold a block). A value that
 * starts or ends with a backtick or a space is padded with one space on each
 * side, which CommonMark strips again, so it cannot merge with the delimiter.
 */
export function markdownCodeSpan(text: string): string {
  const value = text.replace(INLINE_LINE_BREAK, ' ');
  const fence = '`'.repeat(longestBacktickRun(value) + 1);
  const pad = /^[` ]|[` ]$/.test(value) ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}
