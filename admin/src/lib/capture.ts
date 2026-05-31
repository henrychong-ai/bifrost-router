/**
 * Client-side capture (v1.26.0) — a small ring buffer of console errors/warnings,
 * failed network requests (status + URL + method only, no bodies), and
 * navigation breadcrumbs, plus the Tier-1 environment context builder.
 *
 * Installed once at app boot. Every captured string is credential-redacted on
 * the client before it ever leaves the page (the server redacts again on
 * receipt — defence in depth).
 */

import {
  redactSensitive,
  type FeedbackBreadcrumb,
  type FeedbackCaptureBundle,
  type FeedbackConsoleEntry,
  type FeedbackContext,
  type FeedbackNetworkEntry,
} from '@bifrost/shared';

const MAX_ENTRIES = 30;
const consoleBuf: FeedbackConsoleEntry[] = [];
const networkBuf: FeedbackNetworkEntry[] = [];
const breadcrumbBuf: FeedbackBreadcrumb[] = [];
let installed = false;

function push<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.shift();
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Patch console.error/warn/log + fetch to feed the ring buffers. Idempotent. */
export function installCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  (['error', 'warn', 'log'] as const).forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        push(consoleBuf, {
          level,
          message: redactSensitive(args.map(stringifyArg).join(' ')).slice(0, 1000),
          ts: Date.now(),
        });
      } catch {
        /* never break the console */
      }
      original(...args);
    };
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    try {
      const res = await originalFetch(...args);
      if (!res.ok) {
        push(networkBuf, { method, url: redactSensitive(url), status: res.status, ts: Date.now() });
      }
      return res;
    } catch (err) {
      push(networkBuf, { method, url: redactSensitive(url), status: 0, ts: Date.now() });
      throw err;
    }
  };
}

/** Record a navigation / action breadcrumb. */
export function addBreadcrumb(type: string, detail: string): void {
  push(breadcrumbBuf, { type, detail: redactSensitive(detail).slice(0, 300), ts: Date.now() });
}

/** Snapshot the current capture buffers (for attaching to a submission). */
export function getCaptureBundle(): FeedbackCaptureBundle {
  return {
    console: [...consoleBuf],
    network: [...networkBuf],
    breadcrumbs: [...breadcrumbBuf],
  };
}

/** Assemble the Tier-1 environment context (client-known fields; server adds appVersion + rayId). */
export function buildFeedbackContext(routePattern?: string): FeedbackContext {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return {
    url: typeof location !== 'undefined' ? location.href : '',
    route: routePattern,
    timestamp: new Date().toISOString(),
    userAgent: ua,
    browser: detectBrowser(ua),
    os: detectOS(ua),
    viewport:
      typeof window !== 'undefined'
        ? { width: window.innerWidth, height: window.innerHeight }
        : undefined,
    locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
    referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    breadcrumbCount: breadcrumbBuf.length,
  };
}

function detectBrowser(ua: string): string | undefined {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  return undefined;
}

function detectOS(ua: string): string | undefined {
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os|macintosh/i.test(ua)) return 'macOS';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/linux/i.test(ua)) return 'Linux';
  return undefined;
}
