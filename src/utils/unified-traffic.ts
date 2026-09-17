import { isCloudflareHealthcheckUserAgent, normalizeAnalyticsPath } from '@bifrost/shared';

export const UNIFIED_TRAFFIC_MAX_LATENCY_MS = 120_000;
export const UNIFIED_TRAFFIC_MAX_CACHE_STATUS_LENGTH = 32;

/** Public template paths contain no private-share bearer capability. */
export function privacySafeUnifiedAnalyticsPath(path: string): string {
  return normalizeAnalyticsPath(path);
}

// =============================================================================
// Credential redaction for the legacy per-feature analytics recorders
// =============================================================================

/**
 * Whether a query parameter's VALUE must be redacted.
 *
 * `rawValue` is the raw text after the segment's first `=`, exactly as
 * received, or `undefined` for a bare flag. The NAME-ONLY policy ignores it;
 * the LEGACY policy consults it for the four names that are genuinely ambiguous
 * between a credential and a campaign parameter.
 */
type SensitiveQueryParam = (name: string, rawValue: string | undefined) => boolean;

const REDACTED_VALUE = '[redacted]';

/**
 * The characters the WHATWG URL parser removes from anywhere in a URL. Anything
 * that reads a URL the way a browser will must drop them first, or a name like
 * `to<TAB>ken` scans clean and is then fetched as `token`.
 */
const URL_STRIPPED_CHARACTERS = /[\t\n\r]/g;

/**
 * Decode one query component the way a form parser would (`+` is a space).
 * Malformed percent-encoding is tested in its RAW form rather than thrown on.
 */
function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * Credential-bearing parameter NAMES. Short links are used as landing URLs for
 * magic-link / verification flows outside this router's control, and analytics
 * rows are long-lived, so the VALUE of a credential-named parameter never
 * reaches D1. Parameter names survive so analytics shape is kept.
 *
 * Substring stems catch compound provider names (client_secret, oauth_token,
 * session_token, token_hash, SAMLResponse, oobCode, X-Amz-Signature, …);
 * short generic words stay exact-match so parameters like `utm_keyword` or
 * `author` keep their raw analytics value. The exact-match group tolerates a
 * PHP/Rails array suffix — bare `[]` and indexed `[0]` alike — so `code[0]` and
 * `state[]` are recognised while `codec` and `statement` stay raw.
 */
function isSensitiveQueryParamName(rawName: string): boolean {
  const name = decodeQueryComponent(rawName).trim();
  if (
    /(?:token|secret|passw|credential|assert|saml|signature|jwt|otp|ticket|nonce|oob)/i.test(name)
  ) {
    return true;
  }
  if (/^x-amz-/i.test(name)) return true;
  return /^(?:code|key|auth|sig|session|state|api[-_]?key|apikey|code_verifier)(?:\[\d*\])?$/i.test(
    name,
  );
}

/**
 * NAME-ONLY policy. Used by {@link findCredentialParams}, which backs the
 * route-target guard: there a human is being asked, so an ambiguous name is
 * surfaced at any length and the operator decides.
 */
const isSensitiveByName: SensitiveQueryParam = name => isSensitiveQueryParamName(name);

/**
 * Length at or above which an ambiguous parameter's value is treated as a
 * credential by the LEGACY policy.
 *
 * `code`, `state`, `session` and `ticket` are the four names that read equally
 * as marketing copy and as bearer material. A promo code (`SUMMER25`), a region
 * (`CA`), an agenda session (`morning`) and a ticket tier (`vip`) are short
 * words; an OAuth authorisation code, a CSRF `state`, a session identifier and
 * a service ticket are long random strings. The rule errs toward redaction:
 * anything from 20 characters up is redacted even if it is a campaign value,
 * because a stored credential is irreversible and a lost attribution value is
 * not a security incident.
 */
export const LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH = 20;

/**
 * Length at which an all-hex ambiguous value is treated as a credential —
 * session ids, service tickets and digests are hex; promo codes are not.
 */
export const LEGACY_AMBIGUOUS_MIN_HEX_LENGTH = 12;

/**
 * Length at which an ambiguous value carrying upper, lower AND digit is treated
 * as a credential — the shape of a generated token, not of a typed word.
 */
export const LEGACY_AMBIGUOUS_MIN_MIXED_LENGTH = 10;

/**
 * The four EXACT names the legacy policy treats as ambiguous, with the same
 * `[]`/`[n]` array suffix the name predicate tolerates. ⚠️ `ticket` is ALSO a
 * substring stem, so only the bare name is ambiguous: `cas_ticket`,
 * `ticket_id` and friends never reach this pattern and stay always-redacted.
 * `key` is deliberately NOT here — it is the conventional API-key parameter.
 */
const LEGACY_AMBIGUOUS_NAME_PATTERN = /^(?:code|state|session|ticket)(?:\[\d*\])?$/i;

/**
 * LEGACY policy (`legacyQueryString`, `legacyReferrer`) — identical to the
 * name-only predicate EXCEPT for the four ambiguous names above, where the
 * once-decoded value's SHAPE decides. The legacy attribution tables exist to
 * answer campaign questions, and `?code=SUMMER25` is a campaign answer.
 */
const isSensitiveLegacyQueryParam: SensitiveQueryParam = (name, rawValue) => {
  if (LEGACY_AMBIGUOUS_NAME_PATTERN.test(decodeQueryComponent(name).trim())) {
    return isAmbiguousValueCredentialShaped(decodeQueryComponent(rawValue ?? ''));
  }
  return isSensitiveQueryParamName(name);
};

/**
 * Whether an ambiguous name's value LOOKS like bearer material.
 *
 * Length alone was too blunt: a 16-character hex session id and a random
 * mixed-case token both sit under the 20-character floor, while the campaign
 * values the rule exists to protect (`SUMMER25`, `BLACKFRIDAY2026`,
 * `earlybird2026`) are words and never satisfy either shape. Any ONE of three
 * tests is enough, because each describes a value a human would not have typed:
 *
 *  - long enough on its own (the original floor);
 *  - hex throughout at session-id length — ids, tickets, digests;
 *  - upper, lower AND digit at token length — the random-token shape.
 *
 * ⚠️ Cost: a mixed-case campaign value carrying a digit, such as
 * `Summer2026Sale`, is redacted too. Name those parameters `promo=` or `tier=`,
 * which are never matched, or keep the value single-case.
 *
 * Documented residual: an all-numeric value below the hex length (an OTP-shaped
 * `code=123456`) stays raw. Shortening the floors far enough to catch it would
 * redact ordinary short campaign codes, which is the harm this rule exists to
 * avoid.
 */
function isAmbiguousValueCredentialShaped(value: string): boolean {
  if (value.length >= LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH) return true;
  if (value.length >= LEGACY_AMBIGUOUS_MIN_HEX_LENGTH && /^[0-9a-f]+$/i.test(value)) return true;
  return (
    value.length >= LEGACY_AMBIGUOUS_MIN_MIXED_LENGTH &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value)
  );
}

interface QuerySegmentScan {
  /** The rebuilt query, without its leading `?`. */
  query: string;
  /** Decoded names whose value was replaced, in encounter order, with repeats. */
  redactedNames: string[];
}

/**
 * Segment-wise redaction that preserves raw full-fidelity semantics for every
 * NON-sensitive parameter: separators, duplicate keys, empty values, unusual
 * encodings, and malformed bytes are stored byte-identically. Only the text
 * after the `=` of a recognised sensitive pair is replaced (a URLSearchParams
 * round-trip would re-encode and mutate unrelated data).
 *
 * Fidelity rule: a value in which nothing was redacted is stored
 * byte-identically; a value in which something was redacted is re-encoded when
 * the rebuilt text would otherwise carry ambiguous structure.
 */
function scanQuerySegments(query: string, isSensitive: SensitiveQueryParam): QuerySegmentScan {
  const redactedNames: string[] = [];
  const rebuilt = query
    .split('&')
    .map(segment => redactSegment(segment, isSensitive, redactedNames))
    .join('&');
  return { query: rebuilt, redactedNames };
}

/**
 * One `&` segment, under TWO readings COMBINED.
 *
 * A segment is a `;`-separated list of pairs — some servers still split on `;`
 * — and each pair's value may itself be an encoded URL carrying a query or a
 * fragment. Treating the two readings as alternatives lets one silently discard
 * the other's redactions, so they are applied in sequence over the same text:
 *
 *  1. PER PIECE: the predicate on the piece's own `name=value`, and, failing
 *     that, ONE decode of its value read as a URL (query + fragment).
 *  2. WHOLE VALUE: one decode of everything after the segment's own `=`, read
 *     the same way. This is what catches a `;` that lives INSIDE an encoded
 *     value (`…/path;v?token=…`), which reading 1 has already split apart. It
 *     runs over the result of reading 1, so nothing found there is lost, and it
 *     only rewrites when it finds something reading 1 did not.
 *
 * The budget is ONE decode per reading and no recursion, so a double-encoded
 * nesting (`%253A…`) stays invisible by design.
 */
function redactSegment(
  segment: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  const perPiece = segment
    .split(';')
    .map(piece => redactPiece(piece, isSensitive, redactedNames))
    .join(';');

  // Reading 2, over reading 1's result. An already-redacted pair re-read here
  // produces identical text and is therefore not counted again.
  const eq = perPiece.indexOf('=');
  if (eq === -1) return perPiece;
  const wholeNames: string[] = [];
  const rebuilt = redactValueAsUrl(
    perPiece.slice(0, eq),
    perPiece.slice(eq + 1),
    isSensitive,
    wholeNames,
  );
  if (wholeNames.length === 0) return perPiece;
  redactedNames.push(...wholeNames);
  return rebuilt;
}

/** One `;` piece: the predicate first, then a one-decode URL reading. */
function redactPiece(
  piece: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  const redacted = redactPair(piece, isSensitive, redactedNames);
  if (redacted !== piece) return redacted;
  const eq = piece.indexOf('=');
  if (eq === -1) return piece;
  return redactValueAsUrl(piece.slice(0, eq), piece.slice(eq + 1), isSensitive, redactedNames);
}

/**
 * Replace one `name=value` pair's value when the predicate matches it.
 *
 * Returns the pair unchanged when the name is innocuous, when there is no value
 * to replace (a bare flag — the NAME is never the secret), or when the value is
 * ALREADY `[redacted]`: reading the same pair twice under two interpretations
 * must not report a second find.
 */
function redactPair(
  pair: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  const eq = pair.indexOf('=');
  const name = eq === -1 ? pair : pair.slice(0, eq);
  const value = eq === -1 ? undefined : pair.slice(eq + 1);
  if (!isSensitive(name, value)) return pair;
  if (value === undefined) return pair;
  const replaced = `${name}=${REDACTED_VALUE}`;
  if (replaced === pair) return pair;
  redactedNames.push(decodeQueryComponent(name).trim());
  return replaced;
}

/**
 * Decode a pair's value ONCE and read it as a URL: its query and its fragment
 * are both scanned for credential-named pairs.
 *
 * ⚠️ Tab, LF and CR are stripped from the DECODED value before scanning.
 * `?next=https%3A%2F%2Fidp%2F%3Fto%09ken%3DLIVE` carries no literal control
 * character, so the schema and the outer scans see nothing — but the one
 * permitted decode yields `to<TAB>ken=LIVE`, and a browser following that URL
 * strips the tab and sends `token=LIVE`.
 *
 * ⚠️ The nested FRAGMENT is scanned too: a fragment reaches the browser intact,
 * so `…%23token%3DLIVE` is a live credential.
 *
 * Re-encoding is the price of a catch, and only of a catch: when nothing is
 * redacted the caller's text is returned byte-identically.
 */
function redactValueAsUrl(
  name: string,
  value: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  const pair = `${name}=${value}`;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed encoding — there is no second reading of this value.
    return pair;
  }
  // A control character in a URL is never legitimate, and the parser removes it.
  decoded = decoded.replace(URL_STRIPPED_CHARACTERS, '');

  const names: string[] = [];
  const rebuilt = redactUrlText(decoded, isSensitive, names);
  if (names.length === 0) return pair;
  redactedNames.push(...names);

  // Re-encoded unconditionally: this function only ever rewrites a value it
  // had to DECODE to read, so the rebuilt text carries structure (`?`, `#`, a
  // decoded `;`) that must not be spliced back raw. The plain `;` sub-pair case
  // never reaches here — reading 1 redacts it in place, separators intact.
  return `${name}=${encodeURIComponent(rebuilt)}`;
}

/**
 * A decoded value read as `head?query#fragment`, with the query and the
 * fragment scanned and the head read as a pair list. Pieces separated by `;`
 * are read individually first, so a `;`-splitting server sees the same
 * redactions. No further decoding happens here — that is the depth-one bound.
 */
function redactUrlText(
  text: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  return text
    .split(';')
    .map(piece => {
      const hashStart = piece.indexOf('#');
      const questionStart = piece.indexOf('?');
      const hasQuery = questionStart !== -1 && (hashStart === -1 || questionStart < hashStart);
      const bodyEnd = hashStart === -1 ? piece.length : hashStart;

      // The piece is always split before anything is judged, so a reported NAME
      // is the parameter's own name and never the URL text in front of it. The
      // head is scanned as a PAIR LIST, not one pair: a decoded value with no `?`
      // and no `#` may itself be a packed `k=v&k=v` body
      // (`?rt=uid%3D1%26token%3D…`), and a single-pair read would judge only its
      // first name.
      const head = piece.slice(0, hasQuery ? questionStart : bodyEnd);
      const rebuiltHead = redactPairs(head, isSensitive, redactedNames);
      const rebuiltQuery = hasQuery
        ? `?${redactPairs(piece.slice(questionStart + 1, bodyEnd), isSensitive, redactedNames)}`
        : '';
      const rebuiltFragment =
        hashStart === -1
          ? ''
          : `#${redactFragment(piece.slice(hashStart + 1), isSensitive, redactedNames)}`;
      return `${rebuiltHead}${rebuiltQuery}${rebuiltFragment}`;
    })
    .join(';');
}

/** A `k=v&k=v` list, each entry also split on `;`. No decoding. */
function redactPairs(
  text: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  return text
    .split('&')
    .map(entry =>
      entry
        .split(';')
        .map(pair => redactPair(pair, isSensitive, redactedNames))
        .join(';'),
    )
    .join('&');
}

/**
 * A fragment, in BOTH of its shapes: a hash-routed path with its own query, and
 * a bare `k=v&k=v` body. OAuth implicit-flow URLs are routinely both at once,
 * and taking only the text after the first `?` dropped whatever sat before it.
 */
function redactFragment(
  fragment: string,
  isSensitive: SensitiveQueryParam,
  redactedNames: string[],
): string {
  const questionStart = fragment.indexOf('?');
  if (questionStart === -1) return redactPairs(fragment, isSensitive, redactedNames);
  return `${redactPairs(fragment.slice(0, questionStart), isSensitive, redactedNames)}?${redactPairs(
    fragment.slice(questionStart + 1),
    isSensitive,
    redactedNames,
  )}`;
}

/**
 * The segment-wise core, over a query WITHOUT its leading `?`. Split out so
 * `legacyReferrer()` can redact a query it has already delimited without the
 * `?`-stripping below eating a second, literal `?` (`…/a??q=x`).
 */
function redactQuerySegments(query: string, isSensitive: SensitiveQueryParam): string {
  return scanQuerySegments(query, isSensitive).query;
}

/** Shared `?`-handling for a whole search string; an absent query stays NULL. */
function redactQueryString(search: string, isSensitive: SensitiveQueryParam): string | null {
  if (!search) return null;
  return `?${redactQuerySegments(search.startsWith('?') ? search.slice(1) : search, isSensitive)}`;
}

/**
 * The credential-named parameters in `target` — a configured route target, a
 * full URL, or anything else carrying a `?`. Values are never returned, only
 * names, as written by the caller (percent-decoded, trimmed, case preserved).
 * Names found by the bounded second look are included, so a credential nested
 * inside `?next=…` is reported under its own name.
 *
 * ⚠️ Uses the NAME-ONLY predicate, deliberately NOT the narrowed legacy rule.
 * Its caller is the route-target guard, which REFUSES a write and asks a human;
 * there, `?code=SUMMER25` should be surfaced as `code` so the operator can look
 * at it and acknowledge. The legacy shape rule exists to keep campaign data in
 * rows nobody will ever review — the opposite situation.
 *
 * The query runs from the first `?` to the first `#`, exactly as
 * `legacyReferrer()` delimits it: a `?` that only appears inside the fragment
 * is a hash route, not a query.
 */
export function findCredentialParams(target: string): string[] {
  const names: string[] = [];
  const scan = (query: string) => {
    names.push(...scanQuerySegments(query, isSensitiveByName).redactedNames);
  };

  const hashStart = target.indexOf('#');
  const beforeFragment = hashStart === -1 ? target : target.slice(0, hashStart);
  const fragment = hashStart === -1 ? '' : target.slice(hashStart + 1);

  const queryStart = beforeFragment.indexOf('?');
  if (queryStart !== -1) scan(beforeFragment.slice(queryStart + 1));

  // ⚠️ The FRAGMENT is scanned here and nowhere else. The recorders leave it
  // alone for REFERRERS because browsers strip a fragment before sending one —
  // but a route target travels the opposite direction: the Worker puts it in
  // `Location:` and the browser KEEPS the fragment, so
  // `https://app/#/reset?token=…` and an implicit-flow `#access_token=…` are
  // live credentials handed to every visitor.
  //
  // BOTH halves are scanned: a fragment can be a hash-routed path with its own
  // query, a bare `k=v&k=v` body, or — as OAuth implicit-flow URLs in the wild
  // are — both at once (`#access_token=…&redirect=/a?b=1`). Taking only the
  // text after the first `?` dropped the credential sitting before it.
  if (fragment) {
    const fragmentQueryStart = fragment.indexOf('?');
    if (fragmentQueryStart === -1) {
      scan(fragment);
    } else {
      scan(fragment.slice(0, fragmentQueryStart));
      scan(fragment.slice(fragmentQueryStart + 1));
    }
  }

  return [...new Set(names)];
}

/**
 * Query string persisted by the LEGACY per-feature recorders (`page_views`,
 * `link_clicks`, `file_downloads`, `proxy_requests`).
 *
 * These tables keep raw full fidelity for every non-sensitive parameter:
 * `utm_*` and the rest are stored byte-identically, which is the whole point of
 * these rows (campaign attribution reads them directly). Only the VALUES of
 * credential-named parameters become `[redacted]`, so a short link used as the
 * landing URL of a magic-link or OAuth flow no longer parks a live credential
 * in D1.
 *
 * Deliberately NOT clamped: the unified stream's length ceilings exist because
 * unified rows are captured on every host; the legacy recorders only fire on
 * configured routes.
 */
export function legacyQueryString(url: URL): string | null {
  return redactQueryString(url.search, isSensitiveLegacyQueryParam);
}

/**
 * Referrer persisted by the LEGACY per-feature recorders.
 *
 * The Referer header carries the credential one column over from the query
 * string: a magic-link landing page that redirects through a short link sends
 * its own `?token=…` URL as the referrer. Same LEGACY policy as the
 * query-string path, so the two can never drift on what counts as sensitive.
 *
 * Byte-fidelity by construction — no `new URL()` anywhere. Parsing would
 * normalise the origin, re-encode the path, and silently drop anything that is
 * not a URL (`android-app://…`, a relative referrer, a malformed header), so
 * the query component is located by string scan instead: it runs from the first
 * `?` to the first `#`, and everything outside it is preserved exactly as
 * received. A `?` that appears only INSIDE the fragment (`…/p#/route?code=x`, a
 * hash-routed page) is not a query, so that referrer is returned untouched.
 * Known limit: the fragment itself is never scanned, so `…/cb#access_token=…`
 * is stored as sent. Browsers strip the fragment from `Referer`; only a
 * hand-built header can carry one.
 */
export function legacyReferrer(referrer: string | undefined): string | undefined {
  if (!referrer) return referrer;
  const queryStart = referrer.indexOf('?');
  const hashStart = referrer.indexOf('#');
  // No query component: no `?` at all, or the first `?` sits inside the
  // fragment (`…/p#/route?code=x` — a hash-routed page, not a query).
  if (queryStart === -1 || (hashStart !== -1 && hashStart < queryStart)) return referrer;
  const queryEnd = hashStart === -1 ? referrer.length : hashStart;
  return `${referrer.slice(0, queryStart)}?${redactQuerySegments(referrer.slice(queryStart + 1, queryEnd), isSensitiveLegacyQueryParam)}${referrer.slice(queryEnd)}`;
}

const AUTOMATION_PATH_PATTERN =
  /(?:^|\/)(?:\.env|\.git|wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|vendor\/phpunit)(?:\/|$)/i;
const AUTOMATION_USER_AGENT_PATTERN =
  /(?:bot(?:\/|\b)|crawler|spider|slurp|curl\/|wget\/|python-requests|go-http-client|headlesschrome)/i;

export function parseUnifiedTrafficCutoverAt(value: string | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return null;
  }
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

export function parseUnifiedTrafficRetentionDays(value: string | undefined): number | null {
  const raw = value?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}

export function isUnifiedTrafficCaptureActive(
  mode: string | undefined,
  cutoverValue: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (mode !== 'shadow') return false;
  const cutoverAt = parseUnifiedTrafficCutoverAt(cutoverValue);
  return cutoverAt !== null && nowSeconds >= cutoverAt;
}

export function isUnifiedTrafficRequestEligible(input: {
  mode: string | undefined;
  cutoverAt: string | undefined;
  hostname: string;
  adminHostname: string | undefined;
  path: string;
  userAgent: string | undefined;
  nowSeconds?: number;
}): boolean {
  if (!isUnifiedTrafficCaptureActive(input.mode, input.cutoverAt, input.nowSeconds)) return false;
  if (input.adminHostname && input.hostname === input.adminHostname) return false;
  if (
    input.path === '/health' ||
    input.path === '/api' ||
    input.path.startsWith('/api/') ||
    input.path === '/.well-known' ||
    input.path.startsWith('/.well-known/')
  ) {
    return false;
  }
  return !isCloudflareHealthcheckUserAgent(input.userAgent);
}

export function classifyUnifiedTraffic(
  path: string,
  userAgent: string | null | undefined,
): 'browser' | 'automation' | 'unknown' {
  if (AUTOMATION_PATH_PATTERN.test(path) || AUTOMATION_USER_AGENT_PATTERN.test(userAgent ?? '')) {
    return 'automation';
  }
  if (userAgent?.includes('Mozilla/')) return 'browser';
  return 'unknown';
}

export function boundedUnifiedCacheStatus(value: string | null | undefined): string | null {
  const normalised = value?.trim().toUpperCase();
  return normalised ? normalised.slice(0, UNIFIED_TRAFFIC_MAX_CACHE_STATUS_LENGTH) : null;
}

export function boundedUnifiedCountry(value: string | null | undefined): string | null {
  const normalised = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{2}$/.test(normalised) ? normalised : null;
}

export function boundedUnifiedLatencyMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), UNIFIED_TRAFFIC_MAX_LATENCY_MS);
}

export function unifiedTrafficOutcome(
  status: number,
): 'redirect' | 'success' | 'client_error' | 'server_error' {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  // 304 is a successful cache revalidation, not a redirect. The raw status is
  // still stored alongside the outcome, so no fidelity is lost, and the
  // `outcome` CHECK constraint admits no new value.
  if (status === 304) return 'success';
  if (status >= 300) return 'redirect';
  return 'success';
}
