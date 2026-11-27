import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blockedRequestsMessage,
  guardFetch,
  installNetworkGuard,
  isNonLocalUrl,
  takeBlockedRequests,
} from './network-guard';

/** A credential-shaped value in a path and a query: no refusal may repeat it. */
const MARKER = 'tok-marker-7Qx';
const SECRET_URL = `https://api.example.net/sdk/${MARKER}/events?token=${MARKER}`;

type Fetch = (input: unknown, init?: unknown) => Promise<unknown>;

afterEach(() => {
  // Refusals provoked on purpose here must not trip the setup-file hook.
  takeBlockedRequests();
});

describe('isNonLocalUrl', () => {
  it.each([
    'https://api.example.net/sdk/v1/projects/bootstrap/',
    'http://example.com/',
    'https://bifrost.example.com/api/routes',
    'wss://example.com/socket',
    'ws://example.com/socket',
  ])('treats %s as non-local', url => {
    expect(isNonLocalUrl(url)).toBe(true);
  });

  it.each([
    'http://localhost/api/routes',
    'http://localhost:3000/x',
    'http://127.0.0.1:8787/api',
    'http://[::1]/x',
    'ws://localhost:5173/hmr',
    '/api/routes',
    'api/routes?x=1',
    'data:text/plain,hi',
    'blob:http://localhost/abc',
  ])('treats %s as local', url => {
    expect(isNonLocalUrl(url)).toBe(false);
  });
});

describe('guardFetch', () => {
  it('refuses and records a non-local request without calling the original, naming no URL', async () => {
    const original = vi.fn<Fetch>(async () => 'ok');
    const guarded = guardFetch(original);
    const error = await guarded(SECRET_URL).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^\[network-guard\] fetch: non-local host is blocked/);
    expect(message).not.toContain(MARKER);
    expect(message).not.toContain('api.example.net');
    expect(original).not.toHaveBeenCalled();
    const recorded = takeBlockedRequests();
    expect(recorded).toEqual([{ api: 'fetch', reason: 'non-local host' }]);
    expect(blockedRequestsMessage(recorded)).not.toContain(MARKER);
  });

  it('reads the URL from a Request-like object and a URL', async () => {
    const guarded = guardFetch(vi.fn<Fetch>(async () => 'ok'));
    await expect(guarded({ url: 'https://example.com/a' })).rejects.toThrow(/network-guard/);
    await expect(guarded(new URL('https://example.com/b'))).rejects.toThrow(/network-guard/);
    expect(takeBlockedRequests()).toHaveLength(2);
  });

  it('sends a local request with redirect: manual, keeping its other options', async () => {
    const original = vi.fn<Fetch>(async () => 'ok');
    const guarded = guardFetch(original);
    await expect(guarded('/api/routes', { method: 'GET' })).resolves.toBe('ok');
    expect(original).toHaveBeenCalledWith('/api/routes', { method: 'GET', redirect: 'manual' });
    expect(takeBlockedRequests()).toEqual([]);
  });

  it('refuses a local request redirected to a non-local host, naming no URL', async () => {
    const guarded = guardFetch(
      vi.fn<Fetch>(
        async () => new Response(null, { status: 302, headers: { location: SECRET_URL } }),
      ),
    );
    const error = await guarded('http://localhost/start').catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/fetch: redirect to a non-local host is blocked/);
    expect((error as Error).message).not.toContain(MARKER);
    expect(takeBlockedRequests()).toEqual([
      { api: 'fetch', reason: 'redirect to a non-local host' },
    ]);
  });

  it('returns a redirect to this machine as it is, never following it', async () => {
    const redirect = new Response(null, { status: 307, headers: { location: '/next' } });
    const guarded = guardFetch(vi.fn<Fetch>(async () => redirect));
    await expect(guarded('/start')).resolves.toBe(redirect);
    expect(takeBlockedRequests()).toEqual([]);
  });

  it('refuses a redirect whose target cannot be seen', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, headers: new Headers() };
    const guarded = guardFetch(vi.fn<Fetch>(async () => opaque));
    await expect(guarded('/start')).rejects.toThrow(/redirect to a non-local host/);
    expect(takeBlockedRequests()).toHaveLength(1);
  });

  it("reads another realm's answer by its shape, not instanceof", async () => {
    // A plain object, as happy-dom's own Response is to this realm
    const foreign = {
      type: 'basic',
      status: 302,
      headers: { get: (name: string) => (name === 'location' ? SECRET_URL : null) },
    };
    expect(foreign instanceof Response).toBe(false);
    const guarded = guardFetch(vi.fn<Fetch>(async () => foreign));
    await expect(guarded('/start')).rejects.toThrow(/redirect to a non-local host/);
    expect(takeBlockedRequests()).toHaveLength(1);
  });

  it.each([304, 300, 305, 200])('a %i answer is not a redirect', async status => {
    const answer = {
      type: 'basic',
      status,
      headers: { get: (name: string) => (name === 'location' ? SECRET_URL : null) },
    };
    const guarded = guardFetch(vi.fn<Fetch>(async () => answer));
    await expect(guarded('/start')).resolves.toBe(answer);
    expect(takeBlockedRequests()).toEqual([]);
  });

  it('rebuilds a Request input in manual redirect mode', async () => {
    const original = vi.fn<Fetch>(async () => 'ok');
    const guarded = guardFetch(original);
    await guarded(new Request('http://localhost/api/routes', { method: 'POST', body: 'x' }));
    expect(original).toHaveBeenCalledOnce();
    const [sent, init] = original.mock.calls[0] ?? [];
    expect(init).toBeUndefined();
    expect(sent).toBeInstanceOf(Request);
    expect((sent as Request).redirect).toBe('manual');
    expect((sent as Request).method).toBe('POST');
    expect((sent as Request).url).toBe('http://localhost/api/routes');
  });
});

function fakeTarget() {
  const fetch = vi.fn<(input: unknown) => Promise<unknown>>(async () => 'ok');
  const open = vi.fn<(...args: unknown[]) => void>();
  const sendBeacon = vi.fn<(url: unknown, data?: unknown) => boolean>(() => true);
  const opened: string[] = [];
  class FakeXhr {
    readonly kind = 'fake-xhr';
  }
  (FakeXhr.prototype as unknown as { open: unknown }).open = open;
  class FakeSocket {
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      opened.push(`socket ${url}`);
    }
  }
  class FakeEventSource {
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      opened.push(`events ${url}`);
    }
  }
  const target = {
    fetch: fetch as unknown,
    XMLHttpRequest: FakeXhr as unknown as { prototype: { open: (...a: unknown[]) => void } },
    navigator: { sendBeacon: sendBeacon as unknown },
    WebSocket: FakeSocket as unknown,
    EventSource: FakeEventSource as unknown,
  };
  return { target, fetch, open, sendBeacon, opened };
}

describe('installNetworkGuard', () => {
  it('guards fetch, XMLHttpRequest.open, sendBeacon, WebSocket and EventSource', async () => {
    const { target, fetch, open, sendBeacon, opened } = fakeTarget();
    installNetworkGuard(target);

    await expect((target.fetch as (u: string) => Promise<unknown>)(SECRET_URL)).rejects.toThrow(
      /network-guard/,
    );
    expect(fetch).not.toHaveBeenCalled();

    const xhr = new (
      target.XMLHttpRequest as unknown as new () => { open: (...a: unknown[]) => void }
    )();
    expect(() => xhr.open('GET', SECRET_URL)).toThrow(/network-guard/);
    expect(open).not.toHaveBeenCalled();
    xhr.open('GET', '/local');
    expect(open).toHaveBeenCalledWith('GET', '/local');

    const beacon = target.navigator.sendBeacon as (u: string, d?: unknown) => boolean;
    expect(beacon(SECRET_URL)).toBe(false);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(beacon('/local', 'd')).toBe(true);
    expect(sendBeacon).toHaveBeenCalledWith('/local', 'd');

    const Socket = target.WebSocket as new (url: string) => object;
    const Events = target.EventSource as new (url: string) => object;
    expect(() => new Socket(`wss://example.com/${MARKER}`)).toThrow(/WebSocket: non-local host/);
    expect(() => new Events(SECRET_URL)).toThrow(/EventSource: non-local host/);
    expect(new Socket('ws://localhost:5173/hmr')).toBeInstanceOf(Socket);
    expect(new Events('/api/stream')).toBeInstanceOf(Events);
    expect(opened).toEqual(['socket ws://localhost:5173/hmr', 'events /api/stream']);

    const recorded = takeBlockedRequests();
    expect(recorded).toEqual([
      { api: 'fetch', reason: 'non-local host' },
      { api: 'XMLHttpRequest', reason: 'non-local host' },
      { api: 'sendBeacon', reason: 'non-local host' },
      { api: 'WebSocket', reason: 'non-local host' },
      { api: 'EventSource', reason: 'non-local host' },
    ]);
    expect(blockedRequestsMessage(recorded)).not.toContain(MARKER);
    expect(blockedRequestsMessage(recorded)).not.toContain('example');
  });

  it('installs once per target', async () => {
    const { target, fetch } = fakeTarget();
    installNetworkGuard(target);
    const first = target.fetch;
    installNetworkGuard(target);
    expect(target.fetch).toBe(first);
    await (target.fetch as (u: string) => Promise<unknown>)('/local');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('leaves a target without network APIs untouched', () => {
    const target = {};
    expect(() => installNetworkGuard(target)).not.toThrow();
    // Only the symbol install marker is added; no network API is invented.
    expect(Object.keys(target)).toEqual([]);
  });
});

describe('the installed suite guard', () => {
  it('is active on the global fetch of this run', async () => {
    await expect(fetch(SECRET_URL)).rejects.toThrow(/network-guard/);
    expect(takeBlockedRequests()).toHaveLength(1);
  });
});

describe('blockedRequestsMessage', () => {
  it('lists every refused request by API and reason only', () => {
    expect(
      blockedRequestsMessage([
        { api: 'fetch', reason: 'non-local host' },
        { api: 'sendBeacon', reason: 'redirect to a non-local host' },
      ]),
    ).toBe(
      '[network-guard] 2 request(s) to a non-local host were attempted:\n' +
        '  fetch: non-local host\n  sendBeacon: redirect to a non-local host',
    );
  });
});
