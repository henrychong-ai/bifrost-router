/**
 * Link-naming advice (v1.38.0) — shared by the dashboard's route and QR
 * dialogs, so both warn about the same things in the same words.
 *
 * Convention: a link is named after WHAT THE DOCUMENT IS, never after the file
 * behind it — lowercase, hyphenated, with an optional language suffix (`-en`,
 * `-cn`, `-tc`, `-ms`), and no file extension, date, month/year, version, or
 * words like final/draft/copy. Files are the opposite: dated and descriptive
 * (`20260923-example-brochure-corporate-en.pdf`). A link built from
 * the file name goes stale the day the file is replaced, which is exactly when
 * a printed QR code or a sent email still points at it.
 *
 * ADVISORY ONLY: nothing here blocks a write. The server never calls it.
 */

export type LinkNamingIssueCode = 'file-extension' | 'file-name' | 'date' | 'version';

export interface LinkNamingIssue {
  code: LinkNamingIssueCode;
  /** The offending text, lowercased, as it appears in the link. */
  token: string;
  /** One sentence of advice for a person. */
  message: string;
}

/** The standing hint shown under a link-path field. */
export const LINK_NAMING_HINT =
  'Name the link after the document, not the file — no dates, versions or file extensions. The link stays the same when you swap the file later.';

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// A token is a run of letters/digits; lookarounds stop a match from starting or
// ending inside a longer word (`marketing` is not `mar…`, `v2x` is not `v2`).
const START = '(?<![a-z0-9])';
const END = '(?![a-z0-9])';

const between = (value: number, low: number, high: number) => value >= low && value <= high;
const isMonth = (digits: string) => between(Number(digits), 1, 12);
const isDay = (digits: string) => between(Number(digits), 1, 31);
const isCenturyYear = (digits: string) => /^(?:19|20)\d{2}$/.test(digits);
const isTwentyYear = (digits: string) => /^20\d{2}$/.test(digits);

/** `20260923` / `23092026`. */
function isEightDigitDate(digits: string): boolean {
  const ymd =
    isCenturyYear(digits.slice(0, 4)) && isMonth(digits.slice(4, 6)) && isDay(digits.slice(6));
  const dmy =
    isDay(digits.slice(0, 2)) && isMonth(digits.slice(2, 4)) && isCenturyYear(digits.slice(4));
  return ymd || dmy;
}

/** `260923` / `230926` / `072026` (month+year) / `202607`. */
function isSixDigitDate(digits: string): boolean {
  return (
    (isMonth(digits.slice(0, 2)) && isTwentyYear(digits.slice(2))) ||
    (isTwentyYear(digits.slice(0, 4)) && isMonth(digits.slice(4))) ||
    (isMonth(digits.slice(2, 4)) && isDay(digits.slice(4))) ||
    (isDay(digits.slice(0, 2)) && isMonth(digits.slice(2, 4)))
  );
}

/** Ordered: an earlier pattern claims its span before a later one can. */
const TOKEN_PATTERNS: ReadonlyArray<{
  code: 'date' | 'version';
  pattern: RegExp;
  accept?: (token: string) => boolean;
}> = [
  {
    code: 'date',
    pattern: new RegExp(
      `${START}(?:19|20)\\d{2}[-_.](?:0[1-9]|1[0-2])[-_.](?:0[1-9]|[12]\\d|3[01])${END}`,
      'g',
    ),
  },
  { code: 'date', pattern: new RegExp(`${START}${MONTH}[-_.]?(?:20\\d{2}|\\d{2})${END}`, 'g') },
  { code: 'date', pattern: new RegExp(`${START}\\d{8}${END}`, 'g'), accept: isEightDigitDate },
  { code: 'date', pattern: new RegExp(`${START}\\d{6}${END}`, 'g'), accept: isSixDigitDate },
  { code: 'date', pattern: new RegExp(`${START}20\\d{2}${END}`, 'g') },
  { code: 'version', pattern: new RegExp(`${START}(?:final|draft|copy|v\\d+)${END}`, 'g') },
];

/** Lowercase letters and digits only — "ignoring case and separators". */
const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `report.pdf` → `report`; a dotless or dot-leading name is returned unchanged. */
const stem = (name: string) => name.replace(/(.)\.[^.]*$/, '$1');

function lastSegment(value: string): string {
  return value.replace(/\/+$/, '').split('/').pop() ?? '';
}

/**
 * Advisory naming issues for a link path, optionally against the file it
 * serves. Returns an empty list for a well-named link.
 *
 *  - `file-extension` — the link's last segment ends in `.pdf`, `.docx`, …
 *  - `file-name`      — the last segment IS the file's name, with or without
 *                       its extension, ignoring case and separators
 *  - `date`           — `20260923`, `260923`, `2026-09-23`, a bare 20xx year,
 *                       or a month with a year (`aug26`, `sep-2026`, `072026`)
 *  - `version`        — `final`, `draft`, `copy`, `v2`, `v3`, …
 */
export function linkNamingIssues(path: string, fileKey?: string): LinkNamingIssue[] {
  const link = path.trim().toLowerCase().split(/[?#]/)[0] ?? '';
  const last = lastSegment(link);
  const issues: LinkNamingIssue[] = [];

  const extension = /\.([a-z0-9]{1,5})$/.exec(last)?.[1];
  if (extension && /[a-z]/.test(extension) && last.length > extension.length + 1) {
    issues.push({
      code: 'file-extension',
      token: `.${extension}`,
      message: `Remove the file extension (.${extension}) — a link never carries one.`,
    });
  }

  const fileName = fileKey ? lastSegment(fileKey) : '';
  const linkForms = new Set([squash(last), squash(stem(last))]);
  const fileForms = [squash(fileName), squash(stem(fileName))].filter(Boolean);
  if (fileForms.some(form => linkForms.has(form))) {
    issues.push({
      code: 'file-name',
      token: last,
      message: 'This repeats the file name — name the link after what the document is.',
    });
  }

  const claimed: Array<[number, number]> = [];
  const seen = new Set<string>();
  const found: Array<{ at: number; issue: LinkNamingIssue }> = [];
  for (const { code, pattern, accept } of TOKEN_PATTERNS) {
    for (const match of link.matchAll(pattern)) {
      const token = match[0];
      const start = match.index;
      const end = start + token.length;
      if (accept && !accept(token)) continue;
      if (claimed.some(([from, to]) => start < to && end > from)) continue;
      claimed.push([start, end]);
      if (seen.has(`${code}:${token}`)) continue;
      seen.add(`${code}:${token}`);
      found.push({
        at: start,
        issue: {
          code,
          token,
          message:
            code === 'date'
              ? `Remove the date (${token}) — the link should outlive this copy of the file.`
              : `Remove "${token}" — versions and drafts belong in the file name, not the link.`,
        },
      });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...issues, ...found.map(({ issue }) => issue)];
}
