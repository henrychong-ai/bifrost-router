import { hostRefusal, stripTrailingDot } from './host-policy';
import { validateProxyTarget } from './url-validation';

export interface OpenGraphData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string | null;
}

/**
 * Options for {@link parseOpenGraph} (v1.37.0).
 */
export interface OpenGraphFetchOptions {
  /**
   * Redirect hops to follow before giving up (default {@link MAX_REDIRECTS}).
   * Each hop costs one subrequest, so a loop must not run on; all hops share
   * one deadline (v1.40.0).
   */
  maxRedirects?: number;
  /**
   * Resolves hops on hosts this Worker serves in process (v1.37.2). Without
   * it every hop is fetched over the network.
   */
  ownHost?: OwnHostResolver;
}

/**
 * In-process resolution of a preview hop on a host this Worker serves
 * (v1.37.2). A Worker cannot fetch a host it serves through the public edge:
 * the subrequest does not reach the Worker, and the preview fails (typically
 * 502 or 522). The parser asks the resolver instead. A `response` is read
 * exactly like a fetched one: a 3xx is followed under the same hop cap, the
 * body is read under the same size cap, under the preview's one deadline. An
 * `upstream` (a proxy route) is fetched by the parser as a proxied hop: it and
 * every redirect after it pass validateProxyTarget, count against the same
 * cap and share the deadline, the result is reported under the public URL,
 * and no error names the upstream (a refusal gives the minimal result, a
 * failed fetch `HTTP 502`); an og:image the page itself gives may still be an
 * absolute upstream URL. Every hop, own or not, passes the outbound host
 * policy first.
 */
export interface OwnHostResolver {
  /** Whether `url`'s host is served by this Worker. */
  serves(url: URL): boolean;
  /** What a visitor of `url` would get. `signal` aborts at the preview's deadline. */
  resolve(url: URL, signal: AbortSignal): Promise<OwnHostAnswer>;
}

/** A resolver's answer for one own-host hop (v1.37.2). */
export type OwnHostAnswer =
  | { kind: 'response'; response: Response }
  | { kind: 'upstream'; url: URL }
  | { kind: 'minimal' };

/** The request headers of every preview hop, fetched or resolved in process. */
export const OPEN_GRAPH_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Bifrost/1.0 (OpenGraph Parser)',
  Accept: 'text/html',
};

/**
 * Redirect hops a link preview follows before giving up (v1.37.0), also for
 * a preview of a proxy route's upstream. The proxy handler serving visitors
 * has its own loop and a higher cap (`MAX_PROXY_REDIRECTS`, 20, in
 * `handlers/proxy.ts`); the two are separate on purpose.
 */
export const MAX_REDIRECTS = 5;

/** The answer when there is nothing to read: every field null except `url`. */
export function minimalOpenGraph(url: string): OpenGraphData {
  return { title: null, description: null, image: null, siteName: null, url };
}

/**
 * Maximum response size in bytes (1MB)
 * Prevents memory exhaustion attacks
 */
const MAX_RESPONSE_SIZE = 1024 * 1024;

/**
 * The whole preview's deadline in milliseconds: every redirect hop and every
 * body read share it (v1.40.0). Each hop used to get its own 5 s, so a
 * preview that followed the five allowed redirects could take about 30 s.
 */
const PREVIEW_DEADLINE_MS = 5000;

/** Why a link-preview URL was refused (v1.38.0), for the fixed answer of each class. */
export type SSRFRefusal = 'format' | 'scheme' | 'name' | 'ipv4' | 'ipv6';

/** The fixed text for each SSRF refusal class (v1.38.0). */
const SSRF_REFUSAL_DETAILS: Readonly<Record<SSRFRefusal, string>> = {
  format: 'Invalid URL format',
  scheme: 'Blocked scheme',
  name: 'Blocked hostname',
  ipv4: 'Blocked private IP address',
  ipv6: 'Blocked IPv6 address',
};

/**
 * A refused link-preview URL. Its message is the fixed text of its refusal
 * class ({@link SSRF_REFUSAL_DETAILS}), never the URL or its host (v1.38.0).
 */
export class SSRFBlockedError extends Error {
  constructor(readonly reason: SSRFRefusal) {
    super(SSRF_REFUSAL_DETAILS[reason]);
    this.name = 'SSRFBlockedError';
  }
}

/**
 * The upstream (or the in-process answer for an own host) answered a status
 * that has nothing to describe (v1.38.0). The message is `HTTP <status>`.
 */
export class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'UpstreamStatusError';
  }
}

export class TooManyRedirectsError extends Error {
  /** The cap that was applied (`maxRedirects`, else {@link MAX_REDIRECTS}). */
  readonly cap: number;

  constructor(cap: number) {
    super(`Too many redirects (max ${cap})`);
    this.cap = cap;
    this.name = 'TooManyRedirectsError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Validate URL for SSRF protection
 * @throws SSRFBlockedError if URL targets internal resources
 */
export function validateUrlForSSRF(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new SSRFBlockedError('format');
  }

  // Only allow http and https schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SSRFBlockedError('scheme');
  }

  // One shared host policy for every outbound fetch of a caller-supplied URL
  // (src/utils/host-policy.ts, v1.37.2): names, an IPv4 block list and an
  // IPv6 allow-list. Hostnames are not resolved.
  const refusal = hostRefusal(url.hostname);
  if (refusal === 'name') {
    throw new SSRFBlockedError('name');
  }
  if (refusal === 'ipv4') {
    throw new SSRFBlockedError('ipv4');
  }
  if (refusal === 'ipv6') {
    throw new SSRFBlockedError('ipv6');
  }

  return url;
}

/**
 * Longest `<meta …>` or `<title …>` tag read, `<` to `>`: 16 KiB (v1.37.2). A
 * longer tag is skipped whole: no real Open Graph tag comes near it, and the
 * cap bounds the attributes any one tag can contribute.
 */
const MAX_META_TAG_LENGTH = 16 * 1024;

/**
 * The first non-empty `content` for each `property` and each `name` value,
 * lower-cased (v1.37.2).
 */
interface MetaContent {
  property: Map<string, string>;
  name: Map<string, string>;
}

/** HTML's ASCII whitespace. */
function isHtmlSpace(character: string | undefined): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f'
  );
}

/**
 * One start tag (`<meta …>` or `<title …>`), read from `start` (just after
 * its name) to its real closing `>`, and where scanning resumes. Attribute
 * names are lower-cased and the first of a repeated name wins, as in HTML;
 * values may be double-, single- or unquoted, and a `>` inside a quoted value
 * does not end the tag. The tokenizer state is HTML's: a quote opens a value
 * only directly after `=` (and optional ASCII whitespace); in an attribute
 * name or an unquoted value it is an ordinary character, and `>` ends the
 * tag. A tag that does not close before `limit` gives no attributes, but is
 * still read in the same state machine to its real end (v1.37.2): a scan
 * restarted at the limit, or one that treated every quote as opening a value,
 * could read text inside a value as tags. An unclosed quote runs to the end of
 * the page, as in HTML. Each character is read once and scanning resumes
 * after the tag, so the cost is linear.
 */
function readTag(
  html: string,
  start: number,
  limit: number,
): { attributes: Map<string, string> | null; next: number } {
  const attributes = new Map<string, string>();
  const end = html.length;
  let at = start;
  while (at < end) {
    const character = html[at];
    if (character === '>') return { attributes: at < limit ? attributes : null, next: at + 1 };
    if (isHtmlSpace(character) || character === '/') {
      at += 1;
      continue;
    }
    // The first character always belongs to the name (an `=` here too, as
    // in HTML), so every pass advances
    const nameStart = at;
    at += 1;
    while (at < end && !isHtmlSpace(html[at]) && !'/>='.includes(html[at] ?? '')) at += 1;
    const name = html.slice(nameStart, at).toLowerCase();
    while (at < end && isHtmlSpace(html[at])) at += 1;
    let value = '';
    if (at < end && html[at] === '=') {
      at += 1;
      while (at < end && isHtmlSpace(html[at])) at += 1;
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        // The quote's real close, whether or not it is inside the limit: an
        // oversized tag is still skipped whole, and scanning resumes after it
        const from = at + 1;
        const close = html.indexOf(quote, from);
        if (close === -1) return { attributes: null, next: end };
        value = html.slice(from, close);
        at = close + 1;
      } else {
        const valueStart = at;
        while (at < end && !isHtmlSpace(html[at]) && html[at] !== '>') at += 1;
        value = html.slice(valueStart, at);
      }
    }
    // Attributes past the limit are not kept: the tag is only being skipped
    if (at <= limit && !attributes.has(name)) attributes.set(name, value);
  }
  return { attributes: null, next: end };
}

/** Where a tag name ends: ASCII whitespace, `/` or `>` (not NBSP or another Unicode space). */
const TAG_NAME_END = /[\t\n\f\r />]/;

/** Elements whose content is raw text: no tags inside, up to the matching end tag. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);

/** Elements whose content is escapable raw text (RCDATA): no tags inside. */
const RCDATA_ELEMENTS: ReadonlySet<string> = new Set(['title', 'textarea']);

function isAsciiLetter(character: string | undefined): boolean {
  return character !== undefined && /^[A-Za-z]$/.test(character);
}

/**
 * Where scanning resumes after the comment that starts at `open` (`<!--`), as
 * HTML ends one: `<!-->` and `<!--->` close at once; otherwise the first
 * `-->` or `--!>` closes it; an unterminated comment runs to the end.
 */
function commentEnd(html: string, open: number): number {
  if (html.startsWith('<!-->', open)) return open + 5;
  if (html.startsWith('<!--->', open)) return open + 6;
  const close = /--!?>/g;
  close.lastIndex = open + 4;
  const match = close.exec(html);
  return match ? match.index + match[0].length : html.length;
}

const endTagPatterns = new Map<string, RegExp>();

/**
 * Where the end tag `</name` starts (any case, followed by ASCII whitespace,
 * `/` or `>`), or -1. A `</name` at the very end of the input is text, as in
 * HTML, so the element runs to the end.
 */
function findEndTag(html: string, name: string, from: number): number {
  let pattern = endTagPatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
    endTagPatterns.set(name, pattern);
  }
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

/** Whether `name` (lower case) starts at `at`, followed by a tag-name delimiter. */
function tagNameAt(html: string, at: number, name: string): boolean {
  return (
    html.slice(at, at + name.length).toLowerCase() === name &&
    TAG_NAME_END.test(html[at + name.length] ?? '')
  );
}

/**
 * Where a `<script>` element's content ends (the `<` of its `</script`), or
 * -1: the WHATWG script data states, one character at a time. In plain script
 * data, `<!--` enters the escaped dash-dash state. In the escaped states a `-`
 * advances escaped → dash → dash-dash, `>` from dash-dash returns to plain
 * script data (so `<!-->` and `<!--->` close at once), and `<script` starts
 * the double-escaped states, which mirror the escaped ones: their `</script`
 * returns to escaped, and `>` from their dash-dash returns to plain script
 * data. Only `</script` in plain script data or an escaped state ends the
 * element. Linear: every character is visited once.
 */
function findScriptEnd(html: string, from: number): number {
  type State =
    | 'data'
    | 'escaped'
    | 'escapedDash'
    | 'escapedDashDash'
    | 'double'
    | 'doubleDash'
    | 'doubleDashDash';
  let state: State = 'data';
  let at = from;
  while (at < html.length) {
    const character = html[at];
    if (state === 'data') {
      if (character === '<') {
        if (html[at + 1] === '/' && tagNameAt(html, at + 2, 'script')) return at;
        if (html.startsWith('<!--', at)) {
          state = 'escapedDashDash';
          at += 4;
          continue;
        }
      }
      at += 1;
      continue;
    }
    const escaped: boolean =
      state === 'escaped' || state === 'escapedDash' || state === 'escapedDashDash';
    if (character === '<') {
      if (escaped) {
        if (html[at + 1] === '/' && tagNameAt(html, at + 2, 'script')) return at;
        if (tagNameAt(html, at + 1, 'script')) {
          state = 'double';
          at += 1 + 'script'.length;
          continue;
        }
        state = 'escaped';
      } else {
        if (html[at + 1] === '/' && tagNameAt(html, at + 2, 'script')) {
          state = 'escaped';
          at += 2 + 'script'.length;
          continue;
        }
        state = 'double';
      }
    } else if (character === '-') {
      if (state === 'escaped') state = 'escapedDash';
      else if (state === 'escapedDash') state = 'escapedDashDash';
      else if (state === 'double') state = 'doubleDash';
      else if (state === 'doubleDash') state = 'doubleDashDash';
    } else if (character === '>' && (state === 'escapedDashDash' || state === 'doubleDashDash')) {
      state = 'data';
    } else {
      state = escaped ? 'escaped' : 'double';
    }
    at += 1;
  }
  return -1;
}

/**
 * Every `<meta>` tag's `property`/`name` and `content`, and the text of the
 * first `<title>` with any, in ONE linear pass over the whole document
 * (v1.37.2). The regular expressions this replaces backtracked: about 52 KB of
 * unclosed `<meta property='og:title' content='` took tens of seconds.
 *
 * Every tag is read, not only `meta` and `title`, so text inside another tag's
 * attribute value is never taken for markup. A `<` followed by an ASCII letter
 * starts a start tag, read by readTag in HTML's attribute tokenizer states (an
 * oversized one skipped whole); an end tag is read the same way; a comment
 * (`<!--` to `-->`) and `<!…>` or `<?…>` are skipped. The content of `script`
 * (with its escaped states), `style`, `xmp`, `iframe`, `noembed`, `noframes`
 * and `noscript` is raw text, and that of `title` and `textarea` RCDATA: no
 * tag inside any of them is read. A tag name ends only at ASCII whitespace,
 * `/` or `>`. The title is the text of the first `<title>` element that has
 * some, up to `</title`, trimmed; a `<title>` never closed gives no title. Each character is visited a bounded number
 * of times, so the cost is linear.
 */
function scanTags(html: string): MetaContent & { title: string | null } {
  const found: MetaContent & { title: string | null } = {
    property: new Map(),
    name: new Map(),
    title: null,
  };
  const end = html.length;
  let at = 0;
  while (at < end) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    const next = html[open + 1];
    if (html.startsWith('<!--', open)) {
      at = commentEnd(html, open);
      continue;
    }
    if (next === '!' || next === '?' || (next === '/' && !isAsciiLetter(html[open + 2]))) {
      const close = html.indexOf('>', open + 2);
      at = close === -1 ? end : close + 1;
      continue;
    }
    const isEndTag = next === '/';
    const nameStart = open + (isEndTag ? 2 : 1);
    if (!isAsciiLetter(html[nameStart])) {
      at = open + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < end && !TAG_NAME_END.test(html[nameEnd] ?? '')) nameEnd += 1;
    const tag = readTag(html, nameEnd, Math.min(end, open + MAX_META_TAG_LENGTH));
    at = tag.next;
    if (isEndTag) continue;
    const name = html.slice(nameStart, nameEnd).toLowerCase();

    if (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name)) {
      const close = name === 'script' ? findScriptEnd(html, at) : findEndTag(html, name, at);
      if (name === 'title' && found.title === null && tag.attributes && close > at) {
        found.title = decodeHtmlEntities(html.slice(at, close).trim());
      }
      at = close === -1 ? end : close;
      continue;
    }
    if (name !== 'meta' || !tag.attributes) continue;
    const content = tag.attributes.get('content');
    if (!content) continue;
    for (const kind of ['property', 'name'] as const) {
      const key = tag.attributes.get(kind)?.toLowerCase();
      if (key !== undefined && !found[kind].has(key)) found[kind].set(key, content);
    }
  }
  return found;
}

/**
 * The content of the first tag whose `property` is `key`, else of the first
 * whose `name` is `key` (both case-insensitive), entity-decoded.
 */
function metaContent(meta: MetaContent, key: string): string | null {
  const content = meta.property.get(key) ?? meta.name.get(key);
  return content === undefined ? null : decodeHtmlEntities(content);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode the entities a preview's meta content and title carry (every field:
 * title, description, image, site name and url), in ONE pass (v1.37.0).
 * Chained `.replace` calls decoded their own output: with numeric references
 * decoded before `&amp;`, `&#38;amp;` became `&` instead of `&amp;`, and every
 * order leaves some pair that double-decodes. Each entity is now read from the
 * source text exactly once. Named entities are case-sensitive, as in HTML;
 * `&#x`/`&#X` and hex digits are not. Unknown entities stay as written.
 *
 * Numeric references follow the browser for the cases that would otherwise
 * produce an invalid string: `&#0;` and every surrogate (U+D800–U+DFFF)
 * become U+FFFD. A surrogate PAIR written as two references is two lone
 * surrogates, so it gives U+FFFD twice, as HTML parsers do; they are never
 * combined. A number beyond U+10FFFF (including hundreds of digits, which
 * parse to Infinity) stays as written instead of throwing.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|nbsp));/g,
    (entity, decimal?: string, hex?: string, name?: string) => {
      if (name) return NAMED_ENTITIES[name] ?? entity;
      const codePoint = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
      if (!(codePoint <= 0x10ffff)) return entity;
      if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '�';
      return String.fromCodePoint(codePoint);
    },
  );
}

/**
 * Name suffixes refused in `og:image` and `og:url` on top of the host policy
 * (v1.37.2): private-network names the operator's browser may resolve, though
 * the Worker never would (a tailnet, a home or office LAN, and the RFC 6762
 * Appendix G names). Hostnames are not resolved, so a public wildcard-DNS name
 * that answers with a private address (`*.nip.io`, `*.sslip.io`,
 * `localtest.me`) is not caught.
 */
const PRIVATE_BROWSER_SUFFIXES = [
  '.ts.net',
  '.lan',
  '.home.arpa',
  '.corp',
  '.home',
  '.intranet',
  '.private',
  '.localdomain',
] as const;

/**
 * Whether the operator's browser, rather than the Worker, may load `hostname`:
 * it passes the host policy, and it is neither a single-label name (`intranet`,
 * which a browser resolves through the local search domain) nor a name under a
 * private-network suffix. IP literals are left to the host policy.
 */
function isBrowserSafeHost(hostname: string): boolean {
  if (hostRefusal(hostname) !== null) return false;
  if (hostname.startsWith('[')) return true;
  const host = stripTrailingDot(hostname.toLowerCase());
  if (!host.includes('.')) return false;
  return !PRIVATE_BROWSER_SUFFIXES.some(suffix => host.endsWith(suffix) || `.${host}` === suffix);
}

/**
 * `value` resolved against `base`, or null unless the result is http(s)
 * (v1.37.0) on a host the browser may safely load (v1.37.2). `og:image` and
 * `og:url` come from the fetched page, and the dashboard renders the image as
 * an `<img src>` and the URL as a link, so a `javascript:`, `data:`, `blob:`
 * or other scheme is dropped rather than passed through, and so is an
 * internal or private address: the browser would otherwise request it from
 * inside the operator's network.
 */
function resolveHttpUrl(base: string, value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return isBrowserSafeHost(url.hostname) ? url.href : null;
}

/**
 * Cancel a body this parser will not read. A cancel that rejects (a stream
 * that has already errored) must never replace the error or result the caller
 * is about to return (v1.37.1), so its rejection is dropped.
 */
export async function releaseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Read response body with size limit to prevent memory exhaustion. Over the
 * limit (by Content-Length or while streaming), the body is cancelled before
 * ResponseTooLargeError is thrown.
 */
async function readResponseWithSizeLimit(response: Response, maxSize: number): Promise<string> {
  const contentLength = response.headers.get('content-length');

  // Check content-length header first if available. The body is released
  // before the throw, so a refused response does not keep its connection open.
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) {
      await releaseBody(response);
      throw new ResponseTooLargeError(`Response too large: ${size} bytes (max: ${maxSize})`);
    }
  }

  // Stream the response and enforce size limit
  // A fetch Response body is a byte stream.
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > maxSize) {
        // Cancel, not just release: releaseLock() alone (in the finally) leaves
        // the rest of the body arriving.
        // A rejected cancel must not replace the size error (v1.37.1).
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(`Response too large: exceeded ${maxSize} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Combine chunks and decode as UTF-8
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}

/**
 * Parse Open Graph metadata from a URL
 *
 * Security features:
 * - SSRF protection: Blocks private IPs, localhost, cloud metadata endpoints
 * - Size limit: Maximum 1MB response to prevent memory exhaustion; an oversized
 *   body is cancelled, not left streaming
 * - Timeout: one 5 second deadline for the whole preview, every hop included
 * - Scheme validation: Only http/https allowed
 * - Redirects: each hop is validated, at most {@link MAX_REDIRECTS} are followed
 *
 * @throws SSRFBlockedError if URL targets internal resources
 * @throws TooManyRedirectsError if the redirect cap is reached
 * @throws ResponseTooLargeError if response exceeds size limit
 * @throws Error for network/HTTP errors
 */
export function parseOpenGraph(
  url: string,
  options: OpenGraphFetchOptions = {},
): Promise<OpenGraphData> {
  // The hop count lives only in the private recursion: a caller cannot pass
  // one (a stray third argument, as from `urls.map(parseOpenGraph)`), so the
  // cap always counts from zero. One deadline covers every hop (v1.40.0).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PREVIEW_DEADLINE_MS);
  return fetchOpenGraph(url, options, controller.signal, 0).finally(() => clearTimeout(timeoutId));
}

/**
 * `resolving`, or the abort reason once `signal` aborts (the deadline),
 * whichever comes first: an in-process step that does not watch the signal
 * (a KV read) still cannot outlast the deadline. A response that arrives
 * after it is released.
 */
async function resolveWithin(
  resolving: Promise<OwnHostAnswer>,
  signal: AbortSignal,
): Promise<OwnHostAnswer> {
  const onAbort = { listener: (): void => undefined };
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort.listener = () => reject(signal.reason);
  });
  if (signal.aborted) onAbort.listener();
  else signal.addEventListener('abort', onAbort.listener, { once: true });
  try {
    return await Promise.race([resolving, aborted]);
  } catch (error) {
    if (signal.aborted) {
      // Released when it arrives; its own failure no longer matters
      void resolving.then(
        late => (late.kind === 'response' ? releaseBody(late.response) : undefined),
        () => undefined,
      );
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort.listener);
  }
}

/** Whether `error` is the abort at the preview's deadline. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * One hop of {@link parseOpenGraph}; `hop` is the redirects already followed
 * and `signal` aborts at the preview's one deadline.
 * `proxiedFor` is set on a proxy route's upstream hops (v1.37.2): the public
 * URL they are reported under, which also stands in for them in every error.
 */
async function fetchOpenGraph(
  url: string,
  options: OpenGraphFetchOptions,
  signal: AbortSignal,
  hop: number,
  proxiedFor?: string,
): Promise<OpenGraphData> {
  // What a visitor sees: the public URL for an upstream hop
  const reportUrl = proxiedFor ?? url;

  // Validate before any request. An upstream hop is checked as a proxy
  // target, and a refusal describes nothing rather than name the upstream.
  let validatedUrl: URL;
  if (proxiedFor === undefined) {
    validatedUrl = validateUrlForSSRF(url);
  } else {
    const check = validateProxyTarget(url);
    if (!check.valid || !check.url) return minimalOpenGraph(reportUrl);
    validatedUrl = check.url;
    // An upstream on one of our own hosts fails for a visitor too (the
    // proxy's own fetch cannot reach this Worker), so nothing is described
    if (options.ownHost?.serves(validatedUrl)) return minimalOpenGraph(reportUrl);
  }

  let response: Response;
  if (proxiedFor === undefined && options.ownHost?.serves(validatedUrl)) {
    const answer = await resolveWithin(options.ownHost.resolve(validatedUrl, signal), signal);
    if (answer.kind === 'minimal') return minimalOpenGraph(url);
    // The same hop, served by the upstream: fetched as a proxied hop
    if (answer.kind === 'upstream') {
      return fetchOpenGraph(answer.url.href, options, signal, hop, url);
    }
    response = answer.response;
  } else {
    try {
      response = await fetch(validatedUrl.href, {
        signal,
        headers: OPEN_GRAPH_REQUEST_HEADERS,
        // Don't follow redirects automatically - we need to validate each redirect target
        redirect: 'manual',
      });
    } catch (error) {
      // A network error can name the upstream, which a visitor never sees,
      // so it is not kept as a cause either
      if (proxiedFor !== undefined && !isAbort(error)) {
        // eslint-disable-next-line preserve-caught-error -- the cause can name the upstream
        throw new UpstreamStatusError(502);
      }
      throw error;
    }
  }

  // Handle redirects manually to prevent SSRF via redirect. The body is
  // released first on every path that will not read it, so no early return
  // or throw (a bad Location, an SSRF refusal, the hop cap) leaves the
  // connection open.
  if (response.status >= 300 && response.status < 400) {
    await releaseBody(response);
    // Follow at most `maxRedirects` hops, all within the one deadline. The old
    // recursion had no cap, so an A→B→A loop ran until the Worker's
    // subrequest limit. The cap is checked BEFORE the Location is read, so
    // at the cap every 3xx (no Location, a malformed one, or an SSRF target)
    // ends as TooManyRedirects.
    const cap = options.maxRedirects ?? MAX_REDIRECTS;
    if (hop >= cap) {
      // A proxy upstream's redirects are its own business: past the cap
      // there is simply nothing to describe
      if (proxiedFor !== undefined) return minimalOpenGraph(reportUrl);
      throw new TooManyRedirectsError(cap);
    }
    const redirectUrl = response.headers.get('location');
    if (!redirectUrl) throw new UpstreamStatusError(response.status);
    // Resolve relative redirect URLs. The recursive call validates the
    // target for SSRF on entry, before it fetches anything.
    let next: string;
    try {
      next = new URL(redirectUrl, validatedUrl.href).href;
    } catch (error) {
      // An unparseable upstream Location would be quoted by the error
      if (proxiedFor !== undefined) return minimalOpenGraph(reportUrl);
      throw error;
    }
    return fetchOpenGraph(next, options, signal, hop + 1, proxiedFor);
  }

  if (!response.ok) {
    await releaseBody(response);
    throw new UpstreamStatusError(response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    await releaseBody(response);
    return minimalOpenGraph(reportUrl);
  }

  // Read response with size limit
  const html = await readResponseWithSizeLimit(response, MAX_RESPONSE_SIZE);

  const meta = scanTags(html);
  const ogTitle = metaContent(meta, 'og:title') ?? metaContent(meta, 'twitter:title') ?? meta.title;

  const ogDescription =
    metaContent(meta, 'og:description') ??
    metaContent(meta, 'twitter:description') ??
    metaContent(meta, 'description');

  const ogImage = metaContent(meta, 'og:image') ?? metaContent(meta, 'twitter:image');

  const ogSiteName = metaContent(meta, 'og:site_name') ?? metaContent(meta, 'application-name');

  const ogUrl = metaContent(meta, 'og:url');

  return {
    title: ogTitle,
    description: ogDescription,
    image: resolveHttpUrl(reportUrl, ogImage),
    siteName: ogSiteName,
    // A proxied page is reported under its public URL only: an og:url on
    // the upstream would name it (v1.37.2)
    url: proxiedFor === undefined ? (resolveHttpUrl(url, ogUrl) ?? url) : proxiedFor,
  };
}

/** A failed preview as `GET /api/metadata/og` answers it. */
export interface OpenGraphFailure {
  status: 403 | 413 | 502;
  error: string;
  details: string;
}

/** A preview that could not be fetched: 502 with fixed `details`. */
function failedFetch(details: string): OpenGraphFailure {
  return { status: 502, error: 'Failed to fetch URL', details };
}

/**
 * The answer for a preview that failed (v1.38.0): a fixed message for each
 * failure class, never an error's own text, which can name a host or quote a
 * network error. A refused URL is 403 with its refusal class, an oversized
 * page 413, and everything else 502: the redirect cap, a timeout, an upstream
 * status (`HTTP <status>`, a number only) or any other failure.
 */
export function describeOpenGraphFailure(error: unknown): OpenGraphFailure {
  if (error instanceof SSRFBlockedError) {
    return {
      status: 403,
      error: 'URL blocked for security reasons',
      details: SSRF_REFUSAL_DETAILS[error.reason],
    };
  }
  if (error instanceof ResponseTooLargeError) {
    return { status: 413, error: 'Response too large', details: 'The page is over the 1 MB limit' };
  }
  // The cap actually applied, which a caller may have set below the default
  if (error instanceof TooManyRedirectsError) {
    return failedFetch(`Too many redirects (max ${error.cap})`);
  }
  if (error instanceof UpstreamStatusError) return failedFetch(`HTTP ${error.status}`);
  if (isAbort(error)) return failedFetch('The page did not answer in time');
  return failedFetch('The page could not be fetched');
}
