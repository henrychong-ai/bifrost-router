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
   * Each hop costs one subrequest and its own timeout, so a loop must not run
   * on.
   */
  maxRedirects?: number;
}

/** Redirect hops followed before giving up (v1.37.0). */
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
 * Request timeout in milliseconds
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Private IP ranges that should be blocked (SSRF protection)
 * Includes: loopback, private networks, link-local, cloud metadata
 */
const PRIVATE_IP_PATTERNS = [
  // IPv4 loopback (127.0.0.0/8)
  /^127\./,
  // IPv4 private class A (10.0.0.0/8)
  /^10\./,
  // IPv4 private class B (172.16.0.0/12)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  // IPv4 private class C (192.168.0.0/16)
  /^192\.168\./,
  // IPv4 link-local (169.254.0.0/16) - includes AWS/GCP metadata
  /^169\.254\./,
  // IPv4 localhost variations
  /^0\./,
  // IPv6 loopback
  /^::1$/,
  /^\[::1\]$/,
  // IPv6 private (fc00::/7)
  /^f[cd][0-9a-f]{2}:/i,
  // IPv6 link-local (fe80::/10)
  /^fe[89ab][0-9a-f]:/i,
];

/**
 * Hostnames that should be blocked (SSRF protection)
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  // Common internal service names
  'kubernetes',
  'kubernetes.default',
  'metadata',
  'metadata.google.internal',
];

/**
 * Cloud metadata endpoints (commonly targeted in SSRF)
 */
const CLOUD_METADATA_IPS = [
  '169.254.169.254', // AWS, GCP, Azure
  '169.254.170.2', // AWS ECS
  '100.100.100.200', // Alibaba Cloud
];

export class SSRFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}

export class TooManyRedirectsError extends Error {
  constructor(message: string) {
    super(message);
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
    throw new SSRFBlockedError('Invalid URL format');
  }

  // Only allow http and https schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SSRFBlockedError(`Blocked scheme: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();

  // Block explicit blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    throw new SSRFBlockedError(`Blocked hostname: ${hostname}`);
  }

  // Block cloud metadata IPs
  if (CLOUD_METADATA_IPS.includes(hostname)) {
    throw new SSRFBlockedError(`Blocked cloud metadata IP: ${hostname}`);
  }

  // Block private IP patterns
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new SSRFBlockedError(`Blocked private IP: ${hostname}`);
    }
  }

  // Block IPv6 addresses in brackets that might be private
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1);
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(ipv6)) {
        throw new SSRFBlockedError(`Blocked private IPv6: ${ipv6}`);
      }
    }
  }

  return url;
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${property}["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }

  return null;
}

function extractTitle(html: string): string | null {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : null;
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
 * `value` resolved against `base`, or null unless the result is http(s)
 * (v1.37.0). `og:image` and `og:url` come from the fetched page, and the
 * dashboard renders the image as an `<img src>`, so a `javascript:`, `data:`,
 * `blob:` or other scheme is dropped rather than passed through.
 */
function resolveHttpUrl(base: string, value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
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
      await response.body?.cancel();
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
        await reader.cancel();
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
 * - Timeout: 5 second request timeout
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
  // cap always counts from zero.
  return fetchOpenGraph(url, options, 0);
}

/** One hop of {@link parseOpenGraph}; `hop` is the redirects already followed. */
async function fetchOpenGraph(
  url: string,
  options: OpenGraphFetchOptions,
  hop: number,
): Promise<OpenGraphData> {
  // Validate URL for SSRF before making any request
  const validatedUrl = validateUrlForSSRF(url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(validatedUrl.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Bifrost/1.0 (OpenGraph Parser)',
        Accept: 'text/html',
      },
      // Don't follow redirects automatically - we need to validate each redirect target
      redirect: 'manual',
    });

    // Handle redirects manually to prevent SSRF via redirect. The body is
    // released first on every path that will not read it, so no early return
    // or throw (a bad Location, an SSRF refusal, the hop cap) leaves the
    // connection open.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      // Follow at most `maxRedirects` hops, each with its own timeout. The old
      // recursion had no cap, so an A→B→A loop ran until the Worker's
      // subrequest limit. The cap is checked BEFORE the Location is read, so
      // at the cap every 3xx (no Location, a malformed one, or an SSRF target)
      // ends as TooManyRedirects.
      const cap = options.maxRedirects ?? MAX_REDIRECTS;
      if (hop >= cap) {
        throw new TooManyRedirectsError(`Too many redirects (max ${cap})`);
      }
      const redirectUrl = response.headers.get('location');
      if (!redirectUrl) throw new Error(`HTTP ${response.status}`);
      // Resolve relative redirect URLs. The recursive call validates the
      // target for SSRF on entry, before it fetches anything.
      return fetchOpenGraph(new URL(redirectUrl, validatedUrl.href).href, options, hop + 1);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      await response.body?.cancel();
      return minimalOpenGraph(url);
    }

    // Read response with size limit
    const html = await readResponseWithSizeLimit(response, MAX_RESPONSE_SIZE);

    const ogTitle =
      extractMetaContent(html, 'og:title') ??
      extractMetaContent(html, 'twitter:title') ??
      extractTitle(html);

    const ogDescription =
      extractMetaContent(html, 'og:description') ??
      extractMetaContent(html, 'twitter:description') ??
      extractMetaContent(html, 'description');

    const ogImage =
      extractMetaContent(html, 'og:image') ?? extractMetaContent(html, 'twitter:image');

    const ogSiteName =
      extractMetaContent(html, 'og:site_name') ?? extractMetaContent(html, 'application-name');

    const ogUrl = extractMetaContent(html, 'og:url');

    return {
      title: ogTitle,
      description: ogDescription,
      image: resolveHttpUrl(url, ogImage),
      siteName: ogSiteName,
      url: resolveHttpUrl(url, ogUrl) ?? url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
