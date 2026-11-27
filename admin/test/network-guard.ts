// Test-only network guard (v1.47.0). The dashboard suite must never reach a
// real upstream: a live call makes a test depend on the network and on that
// service being up, and a blocked call inside an SDK is usually swallowed, so
// the test still passes and the request goes unnoticed. Every outbound request
// to a host that is not local is refused here and recorded; the setup file
// fails the running test (afterEach) or the file (afterAll) while any refusal
// is recorded. Tests that need a response stub `fetch` themselves, as before.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface BlockedRequest {
  api: 'fetch' | 'XMLHttpRequest' | 'sendBeacon';
  url: string;
}

const blocked: BlockedRequest[] = [];

function baseHref(): string {
  const href = (globalThis as { location?: { href?: unknown } }).location?.href;
  return typeof href === 'string' && href.startsWith('http') ? href : 'http://localhost/';
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) {
    const { url } = input;
    if (typeof url === 'string') return url;
  }
  return String(input);
}

/** True when `url` resolves to a host outside this machine. */
export function isNonLocalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, baseHref());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  }
  return !LOCAL_HOSTNAMES.has(parsed.hostname);
}

function refuse(api: BlockedRequest['api'], url: string): Error {
  blocked.push({ api, url });
  return new Error(
    `[network-guard] ${api} to a non-local host is blocked in dashboard tests: ${url}. ` +
      'Mock the module that makes it or stub fetch in the test.',
  );
}

/** Returns and clears the refusals recorded since the last call. */
export function takeBlockedRequests(): BlockedRequest[] {
  return blocked.splice(0, blocked.length);
}

/** Formats recorded refusals into a single failure message. */
export function blockedRequestsMessage(requests: readonly BlockedRequest[]): string {
  const lines = requests.map(request => `  ${request.api} ${request.url}`);
  return `[network-guard] ${requests.length} request(s) to a non-local host were attempted:\n${lines.join('\n')}`;
}

type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

export function guardFetch(original: FetchLike): FetchLike {
  const guarded: FetchLike = (input, init) => {
    const url = requestUrl(input);
    if (isNonLocalUrl(url)) return Promise.reject(refuse('fetch', url));
    return original(input, init);
  };
  return guarded;
}

interface GuardTarget {
  fetch?: unknown;
  XMLHttpRequest?: { prototype: { open: (...args: unknown[]) => void } };
  navigator?: { sendBeacon?: unknown };
}

const INSTALLED = Symbol.for('bifrost.test.networkGuard');

/** Wraps fetch, XMLHttpRequest.open and navigator.sendBeacon on `target`. */
export function installNetworkGuard(global: object): void {
  // The global's own types are wider than what is wrapped here
  const target = global as GuardTarget;
  const marked = target as GuardTarget & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;

  if (typeof target.fetch === 'function') {
    target.fetch = guardFetch((target.fetch as FetchLike).bind(target));
  }

  const xhrPrototype = target.XMLHttpRequest?.prototype;
  if (xhrPrototype && typeof xhrPrototype.open === 'function') {
    const open = xhrPrototype.open;
    xhrPrototype.open = function guardedOpen(this: unknown, ...args: unknown[]) {
      const url = requestUrl(args[1]);
      if (isNonLocalUrl(url)) throw refuse('XMLHttpRequest', url);
      return open.apply(this, args);
    };
  }

  const navigator = target.navigator;
  if (navigator && typeof navigator.sendBeacon === 'function') {
    const sendBeacon = navigator.sendBeacon as (url: unknown, data?: unknown) => boolean;
    navigator.sendBeacon = (url: unknown, data?: unknown) => {
      const href = requestUrl(url);
      if (isNonLocalUrl(href)) {
        refuse('sendBeacon', href);
        return false;
      }
      return sendBeacon.call(navigator, url, data);
    };
  }
}
