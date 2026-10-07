/**
 * A route path or slug as the tail of an API URL path (v1.39.0): each
 * `/`-separated segment percent-encoded on its own, the slashes kept and any
 * leading ones dropped, for the Worker's `:path{.*}` and `:slug{.*}` routes,
 * which take the rest of the path and decode it. A route path always starts
 * with `/`, and the Worker adds it back, so dropping it loses nothing. Object
 * keys have their own rule, {@link objectKeySegments}, because a key's
 * leading slash is part of the key.
 *
 * One rule for the dashboard and the API client (the MCP server). A raw value
 * pasted into a URL is read as something else: `#` and `?` end the path, a
 * backslash becomes a slash, `%2e` decodes to a dot. A whole value through
 * `encodeURIComponent` hides its slashes as `%2F`, which the dashboard's
 * /api proxy refuses (nginx matches the decoded path but forwards the raw
 * one). A `.` or `..` segment cannot be sent at all, because every URL
 * parser resolves `.` and `..` (and `%2E` spellings of them) before the
 * request leaves, so it would address another value; that throws instead.
 */
export function pathSegments(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 0x2f) start += 1;
  return value
    .slice(start)
    .split('/')
    .map(segment => {
      if (segment === '.' || segment === '..') {
        throw new RangeError('A . or .. path segment cannot be sent in a URL');
      }
      return encodeURIComponent(segment);
    })
    .join('/');
}

/** The message {@link objectKeySegments} throws with (no key in it). */
export const UNADDRESSABLE_OBJECT_KEY =
  'This object key cannot be addressed in a URL: it starts with a slash, or has an empty, . or .. segment';

/**
 * An R2 object key as the tail of an API or public URL path (v1.39.0), each
 * `/`-separated segment percent-encoded on its own, for the Worker's
 * `:key{.+}` routes and a bucket's custom domain.
 *
 * The key is sent exactly or not at all: a key that starts with `/`, has an
 * empty segment (`a//b`, a trailing `/`, the empty key) or a `.` or `..`
 * segment throws a `RangeError` ({@link UNADDRESSABLE_OBJECT_KEY}) instead of
 * being sent. Each would reach the server as another key: a leading slash
 * dropped (as {@link pathSegments} drops a route path's) makes `/report.pdf`
 * address `report.pdf`, `//` is refused by the dashboard's /api proxy and
 * merged by others, and URL parsers resolve dot segments before the request
 * leaves. The Worker refuses every such key too (`validateR2Key`), so none
 * can be acted on through the API; they can only predate it.
 */
export function objectKeySegments(key: string): string {
  return key
    .split('/')
    .map(segment => {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new RangeError(UNADDRESSABLE_OBJECT_KEY);
      }
      return encodeURIComponent(segment);
    })
    .join('/');
}
