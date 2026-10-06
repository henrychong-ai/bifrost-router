/**
 * Search matcher (v1.38.0) — the single predicate behind route search (the
 * Worker's `GET /api/routes`: Routes page, Cmd+K, "View all", MCP
 * `list_routes`), QR list search (Worker `listQRs` AND the dashboard's QR
 * store, which must agree record for record), the QR linked-route picker, and
 * the Cmd+K static-command filter.
 *
 * Words are the lowercased runs of characters between ASCII separators (any
 * ASCII character other than a–z and 0–9: spaces, hyphens, underscores, dots,
 * slashes, …). Every non-ASCII character counts as part of a word, so other
 * scripts (CJK, accented letters) stay whole and one plain regex splits any
 * text in linear time. A field matches a query when ANY of these holds:
 * 1. As typed: the lowercased field contains the trimmed, lowercased query.
 *    Every match the pre-v1.38.0 search found is therefore still found.
 * 2. Joined words: the query's words joined without separators are a
 *    substring of the field's words joined the same way (`summersale`,
 *    `Summer_Sale` and `summer sale` all find `/summer-sale`).
 * 3. Any order: every query word is a substring of the SAME field's words, in
 *    any order (`sale summer` finds `/summer-sale`). Words never combine across
 *    fields, so `github com` does not match path `/github` plus target
 *    `https://example.com`.
 *
 * Deliberately simple: no Unicode normalisation (`café` does not match `cafe`),
 * no percent-decoding, and no regular expression built from input. Cost:
 * word matching is linear and reads at most {@link SEARCH_FIELD_MAX_LENGTH}
 * characters of a field (every legitimate path and R2 key fits); the
 * as-typed check reads the whole field, so it costs field × query, and the
 * query is therefore capped at entry: to 2× {@link SEARCH_QUERY_MAX_LENGTH}
 * UTF-16 units before trimming and lowercasing, then to
 * {@link SEARCH_QUERY_MAX_LENGTH} after lowercasing (`İ` lowercases to two
 * units; the wider first cut keeps final-sigma context). Every check uses that capped query; a capped
 * prefix still finds every route the full query would. A query that was cut,
 * has no letters or digits (`/`, `-`), or has more than
 * {@link SEARCH_QUERY_MAX_WORDS} words gets the as-typed check alone. Route
 * domains also match as typed only: as words, a short path query such as
 * `/tv` would match every route on `example.tv`.
 */

/** UTF-16 units of a query used for matching; longer queries are cut to this. */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * Longest `search` parameter the route and QR list APIs and MCP tools accept —
 * a sanity bound for paths that skip the edge URL-length limit, not the
 * matching cap (a pasted URL up to this length still searches).
 */
export const SEARCH_PARAM_MAX_LENGTH = 2048;

/** Most query words that still get word matching. */
export const SEARCH_QUERY_MAX_WORDS = 12;

/** Leading characters of each field read by word matching. */
export const SEARCH_FIELD_MAX_LENGTH = 1024;

const MATCHING_RULES = `Ignores case and separators (spaces, hyphens, underscores, dots, slashes); every word must appear in the same field, in any order. Other text matches as typed (accents are not folded). A query over ${SEARCH_QUERY_MAX_LENGTH} characters is cut to its first ${SEARCH_QUERY_MAX_LENGTH}; a query over ${SEARCH_QUERY_MAX_LENGTH} characters or ${SEARCH_QUERY_MAX_WORDS} words is matched as typed (case-insensitive substring).`;

/** MCP `list_routes` search wording — one source for the catalog and the Zod tool schema. */
export const ROUTE_SEARCH_DESCRIPTION = `Search term to filter routes. Matches path, target URL, type, status code, bucket, and host header. ${MATCHING_RULES} The domain is matched as typed (case-insensitive substring). Results are ordered by relevance (path matches first), newest first on ties.`;

/** MCP `list_qrs` search wording — one source for the catalog and the Zod tool schema. */
export const QR_SEARCH_DESCRIPTION = `Search over description and id. ${MATCHING_RULES}`;

/** `list_routes` tool description — one source for the tool catalog and the MCP server. */
export const LIST_ROUTES_TOOL_DESCRIPTION =
  'List all routes configured for a domain. Returns route paths, types, targets, and enabled status. Supports search over path, target, type, status code, bucket, and host header (ignoring case and separators, words in any order) and over the domain as typed; search results are ordered by relevance.';

/** `list_qrs` tool description — one source for the tool catalog and the MCP server. */
export const LIST_QRS_TOOL_DESCRIPTION =
  'List QR codes for a domain. Filter by type (url/text/vcard/wifi), exact tag, or a description/id search that ignores case and separators (words in any order); recency-sorted with offset/limit pagination.';

// ASCII separators only: a non-ASCII class would cost ~20x more per character.
const SEPARATORS = /[^a-z0-9\u0080-\uffff]+/;

/** A query parsed once and reused across every field and record. */
export interface ParsedSearchQuery {
  /** Trimmed, lowercased query for the as-typed check, capped to {@link SEARCH_QUERY_MAX_LENGTH} units. */
  raw: string;
  /** Query words, in typed order. Empty when only the as-typed check applies. */
  words: string[];
  /** The words joined with no separator. Empty when only the as-typed check applies. */
  compact: string;
}

/** Route fields read by the route matcher. */
export interface SearchableRoute {
  path: string;
  target?: string | null | undefined;
  type?: string | null | undefined;
  statusCode?: number | null | undefined;
  domain?: string | null | undefined;
  bucket?: string | null | undefined;
  hostHeader?: string | null | undefined;
}

/**
 * Split the first {@link SEARCH_FIELD_MAX_LENGTH} characters of text into
 * lowercase words, breaking on ASCII characters other than `a-z0-9`.
 */
export function tokeniseSearchText(text: string): string[] {
  return text.slice(0, SEARCH_FIELD_MAX_LENGTH).toLowerCase().split(SEPARATORS).filter(Boolean);
}

/** The first `max` UTF-16 units of text, never ending on half a surrogate pair. */
function capUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Cut a `search` parameter to {@link SEARCH_PARAM_MAX_LENGTH} units (never
 * splitting a surrogate pair), so a client can send a long paste and still get
 * results instead of a 400.
 */
export function capSearchParam(text: string): string {
  return capUnits(text, SEARCH_PARAM_MAX_LENGTH);
}

/**
 * Parse a raw query, capped at entry (see the module note): the input is cut
 * to 2× {@link SEARCH_QUERY_MAX_LENGTH} units before trimming and lowercasing —
 * the extra half keeps the casing context of the kept part, so a `Σ` at the
 * cut still lowercases to `σ`, not final `ς` — and the lowercased query is cut
 * to {@link SEARCH_QUERY_MAX_LENGTH}. Returns `null` for a missing, empty or
 * whitespace-only query. A cut, separator-only or over-word-cap query gets no
 * words, so only the as-typed check applies to it.
 */
export function parseSearchQuery(query: string | null | undefined): ParsedSearchQuery | null {
  const input = query ?? '';
  const windowed = capUnits(input, 2 * SEARCH_QUERY_MAX_LENGTH);
  const trimmed = windowed.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  const raw = capUnits(lowered, SEARCH_QUERY_MAX_LENGTH);
  if (windowed !== input || raw !== lowered) return { raw, words: [], compact: '' };
  const words = tokeniseSearchText(trimmed);
  if (words.length > SEARCH_QUERY_MAX_WORDS) return { raw, words: [], compact: '' };
  return { raw, words, compact: words.join('') };
}

function resolveQuery(query: string | ParsedSearchQuery | null | undefined) {
  return typeof query === 'object' ? query : parseSearchQuery(query);
}

/** The field's words, joined without and with separators. */
function fieldWords(text: string) {
  const words = tokeniseSearchText(text);
  return { compact: words.join(''), spaced: words.join(' ') };
}

function wordsMatch(field: { compact: string; spaced: string }, query: ParsedSearchQuery) {
  return (
    field.compact.includes(query.compact) || query.words.every(word => field.spaced.includes(word))
  );
}

function fieldMatches(field: string, query: ParsedSearchQuery): boolean {
  if (field.toLowerCase().includes(query.raw)) return true;
  return query.compact !== '' && wordsMatch(fieldWords(field), query);
}

/**
 * True when any field matches the query (see the module rules). A missing or
 * blank query matches everything; empty or missing fields never match.
 */
export function matchesSearchFields(
  fields: ReadonlyArray<string | null | undefined>,
  query: string | ParsedSearchQuery | null | undefined,
): boolean {
  const parsed = resolveQuery(query);
  if (!parsed) return true;
  return fields.some(field => (field ? fieldMatches(field, parsed) : false));
}

/** Route fields other than path and domain, matched as words. */
function routeDetailFields(route: SearchableRoute): Array<string | null | undefined> {
  return [route.target, route.type, route.statusCode?.toString(), route.bucket, route.hostHeader];
}

/** The searchable fields of a QR record — shared by the Worker and the dashboard. */
export function qrSearchFields(qr: {
  id: string;
  description?: string | null | undefined;
}): Array<string | null | undefined> {
  return [qr.description, qr.id];
}

/**
 * Relevance of a route to a query: 4 = path equals the query once separators
 * are removed, 3 = path starts with it, 2 = path matches, 1 = another field
 * matches (the domain as typed only), 0 = no match.
 */
export function scoreRouteMatch(
  route: SearchableRoute,
  query: string | ParsedSearchQuery | null | undefined,
): number {
  const parsed = resolveQuery(query);
  if (!parsed) return 0;
  if (parsed.compact) {
    const path = fieldWords(route.path);
    if (path.compact === parsed.compact) return 4;
    if (path.compact.startsWith(parsed.compact)) return 3;
    if (wordsMatch(path, parsed)) return 2;
  }
  if (route.path.toLowerCase().includes(parsed.raw)) return 2;
  if (route.domain?.toLowerCase().includes(parsed.raw)) return 1;
  return matchesSearchFields(routeDetailFields(route), parsed) ? 1 : 0;
}

/** True when the route matches the query; a missing or blank query matches every route. */
export function matchesRouteSearch(
  route: SearchableRoute,
  query: string | ParsedSearchQuery | null | undefined,
): boolean {
  const parsed = resolveQuery(query);
  return !parsed || scoreRouteMatch(route, parsed) > 0;
}

/**
 * Keep the routes that match the query, ordered by {@link scoreRouteMatch},
 * newest `createdAt` first on ties, then input order. A missing or blank query
 * returns every route in input order. Always returns a new array.
 */
export function searchAndRankRoutes<
  T extends SearchableRoute & { createdAt?: number | null | undefined },
>(routes: readonly T[], query: string | ParsedSearchQuery | null | undefined): T[] {
  const parsed = resolveQuery(query);
  if (!parsed) return [...routes];
  const ranked = routes
    .map((route, index) => ({ route, index, score: scoreRouteMatch(route, parsed) }))
    .filter(({ score }) => score > 0);
  // In place on the fresh filtered copy: shared code can ship in the
  // dashboard, whose build target predates Array#toSorted.
  ranked.sort(
    (a, b) =>
      b.score - a.score || (b.route.createdAt ?? 0) - (a.route.createdAt ?? 0) || a.index - b.index,
  );
  return ranked.map(({ route }) => route);
}
