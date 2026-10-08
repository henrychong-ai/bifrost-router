/**
 * The one check every paged KV and R2 listing makes on a page's cursor
 * (v1.40.0): a truncated page must hand over a cursor not seen before. A
 * truncated page with no cursor would end the listing early and silently
 * leave records out; a repeated one would loop forever.
 */

/** A listing page, as KV or R2 describe it. */
export interface ListingPage {
  /** More keys follow (KV: `!list_complete`; R2: `truncated`). */
  truncated: boolean;
  /** The cursor for the next page, when there is one. */
  cursor?: string | undefined;
}

/** A truncated listing page that gave no cursor or repeated one. */
export class ListingCursorError extends Error {
  constructor() {
    super('Listing cursor invalid');
    this.name = 'ListingCursorError';
  }
}

/** A KV `list` result as a {@link ListingPage}. */
export function kvListingPage(result: KVNamespaceListResult<unknown, string>): ListingPage {
  return result.list_complete ? { truncated: false } : { truncated: true, cursor: result.cursor };
}

/**
 * The cursor to read next, or undefined once the listing is complete.
 * Records each cursor in `seen`. A truncated page with no cursor, or one
 * already seen, throws `invalid()` (a {@link ListingCursorError} unless the
 * caller has its own class, as the backup does).
 */
export function nextCursor(
  page: ListingPage,
  seen: Set<string>,
  invalid: () => Error = () => new ListingCursorError(),
): string | undefined {
  if (!page.truncated) return undefined;
  const { cursor } = page;
  if (!cursor || seen.has(cursor)) throw invalid();
  seen.add(cursor);
  return cursor;
}
