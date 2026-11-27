// Test-only network guard (v1.47.0). The dashboard suite must never reach a
// real upstream: a live call makes a test depend on the network and on that
// service being up, and a blocked call inside a library is usually swallowed,
// so the test still passes and the request goes unnoticed. Every outbound
// request to a host that is not this machine is refused here and recorded; the
// setup file fails the running test (afterEach) or the file (afterAll) while
// any refusal is recorded. Tests that need a response stub `fetch` themselves.
//
// Guarded: fetch (a local fetch follows no redirect: one that points off this
// machine is refused, and any other redirect answer is returned as it is),
// XMLHttpRequest.open, navigator.sendBeacon, WebSocket and EventSource.
//
// A refusal never names the URL, in its error or in the failure summary: this
// repository is public, so its CI logs are too, and a path or query can carry
// a token. The API name and a fixed reason are all a refusal records.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The guarded APIs, the one detail a refusal records. */
export type GuardedApi = 'fetch' | 'XMLHttpRequest' | 'sendBeacon' | 'WebSocket' | 'EventSource';

/** Why a request was refused: fixed text, never the request's own. */
export type BlockReason = 'non-local host' | 'redirect to a non-local host';

export interface BlockedRequest {
  api: GuardedApi;
  reason: BlockReason;
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

/**
 * True when `url` resolves to a host outside this machine: an http(s) or
 * ws(s) URL whose host is not loopback. Relative URLs resolve against the
 * page's own (local) address; `data:`, `blob:` and other schemes reach no
 * host, so they are local.
 */
export function isNonLocalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, baseHref());
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
  return !LOCAL_HOSTNAMES.has(parsed.hostname);
}

function refuse(api: GuardedApi, reason: BlockReason = 'non-local host'): Error {
  blocked.push({ api, reason });
  return new Error(
    `[network-guard] ${api}: ${reason} is blocked in dashboard tests. ` +
      'Mock the module that makes the request or stub fetch in the test.',
  );
}

/** Returns and clears the refusals recorded since the last call. */
export function takeBlockedRequests(): BlockedRequest[] {
  return blocked.splice(0, blocked.length);
}

/** Formats recorded refusals into a single failure message (no URL). */
export function blockedRequestsMessage(requests: readonly BlockedRequest[]): string {
  const lines = requests.map(request => `  ${request.api}: ${request.reason}`);
  return `[network-guard] ${requests.length} request(s) to a non-local host were attempted:\n${lines.join('\n')}`;
}

type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

/** The `Location` of a redirect answer, when `value` is one; else null. */
function redirectLocation(value: unknown): string | null {
  if (!(value instanceof Response)) return null;
  if (value.type === 'opaqueredirect') return '';
  if (value.status < 300 || value.status > 399) return null;
  return value.headers.get('location');
}

/**
 * Refuses a non-local request, and sends a local one with `redirect: 'manual'`
 * so it can never be redirected off this machine: a redirect answer pointing
 * at a non-local host (or one whose target cannot be seen) is refused, any
 * other is returned to the test as it is.
 */
export function guardFetch(original: FetchLike): FetchLike {
  const guarded: FetchLike = async (input, init) => {
    if (isNonLocalUrl(requestUrl(input))) throw refuse('fetch');
    const options = init && typeof init === 'object' ? init : {};
    const answer = await original(input, { ...options, redirect: 'manual' });
    const location = redirectLocation(answer);
    if (location !== null) {
      const base = requestUrl(input);
      let target: string;
      try {
        target = location === '' ? '' : new URL(location, new URL(base, baseHref())).href;
      } catch {
        target = '';
      }
      if (target === '' || isNonLocalUrl(target)) {
        throw refuse('fetch', 'redirect to a non-local host');
      }
    }
    return answer;
  };
  return guarded;
}

type Constructor = abstract new (...args: never[]) => unknown;

/** A constructor that refuses a non-local URL (its first argument) before constructing. */
function guardConstructor<T extends Constructor>(api: GuardedApi, original: T): T {
  return new Proxy(original, {
    construct(target, args: unknown[], newTarget) {
      if (isNonLocalUrl(requestUrl(args[0]))) throw refuse(api);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
}

interface GuardTarget {
  fetch?: unknown;
  XMLHttpRequest?: { prototype: { open: (...args: unknown[]) => void } };
  navigator?: { sendBeacon?: unknown };
  WebSocket?: unknown;
  EventSource?: unknown;
}

const INSTALLED = Symbol.for('bifrost.test.networkGuard');

/**
 * Wraps fetch, XMLHttpRequest.open, navigator.sendBeacon, WebSocket and
 * EventSource on `global`, once.
 */
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
      if (isNonLocalUrl(requestUrl(args[1]))) throw refuse('XMLHttpRequest');
      return open.apply(this, args);
    };
  }

  const navigator = target.navigator;
  if (navigator && typeof navigator.sendBeacon === 'function') {
    const sendBeacon = navigator.sendBeacon as (url: unknown, data?: unknown) => boolean;
    navigator.sendBeacon = (url: unknown, data?: unknown) => {
      if (isNonLocalUrl(requestUrl(url))) {
        refuse('sendBeacon');
        return false;
      }
      return sendBeacon.call(navigator, url, data);
    };
  }

  for (const api of ['WebSocket', 'EventSource'] as const) {
    const original = target[api];
    if (typeof original === 'function') {
      target[api] = guardConstructor(api, original as Constructor);
    }
  }
}
