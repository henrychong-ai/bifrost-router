export interface OpenGraphData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string | null;
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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function resolveUrl(base: string, relative: string | null): string | null {
  if (!relative) return null;
  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

/**
 * Read response body with size limit to prevent memory exhaustion
 */
async function readResponseWithSizeLimit(response: Response, maxSize: number): Promise<string> {
  const contentLength = response.headers.get('content-length');

  // Check content-length header first if available
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) {
      throw new ResponseTooLargeError(`Response too large: ${size} bytes (max: ${maxSize})`);
    }
  }

  // Stream the response and enforce size limit
  const reader = response.body?.getReader();
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
 * - Size limit: Maximum 1MB response to prevent memory exhaustion
 * - Timeout: 5 second request timeout
 * - Scheme validation: Only http/https allowed
 *
 * @throws SSRFBlockedError if URL targets internal resources
 * @throws ResponseTooLargeError if response exceeds size limit
 * @throws Error for network/HTTP errors
 */
export async function parseOpenGraph(url: string): Promise<OpenGraphData> {
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

    // Handle redirects manually to prevent SSRF via redirect
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const redirectUrl = response.headers.get('location');
      if (redirectUrl) {
        // Resolve relative redirect URLs
        const absoluteRedirectUrl = new URL(redirectUrl, validatedUrl.href).href;
        // Validate redirect target for SSRF
        validateUrlForSSRF(absoluteRedirectUrl);
        // Recursively fetch the redirect target (with max 1 redirect)
        return parseOpenGraph(absoluteRedirectUrl);
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return {
        title: null,
        description: null,
        image: null,
        siteName: null,
        url,
      };
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
      image: resolveUrl(url, ogImage),
      siteName: ogSiteName,
      url: ogUrl ?? url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
