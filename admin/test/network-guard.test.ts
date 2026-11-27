import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blockedRequestsMessage,
  guardFetch,
  installNetworkGuard,
  isNonLocalUrl,
  takeBlockedRequests,
} from './network-guard';

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
  ])('treats %s as non-local', url => {
    expect(isNonLocalUrl(url)).toBe(true);
  });

  it.each([
    'http://localhost/api/routes',
    'http://localhost:3000/x',
    'http://127.0.0.1:8787/api',
    'http://[::1]/x',
    '/api/routes',
    'api/routes?x=1',
    'data:text/plain,hi',
    'blob:http://localhost/abc',
  ])('treats %s as local', url => {
    expect(isNonLocalUrl(url)).toBe(false);
  });
});

describe('guardFetch', () => {
  it('refuses and records a non-local request without calling the original', async () => {
    const original = vi.fn<(input: unknown, init?: unknown) => Promise<unknown>>(async () => 'ok');
    const guarded = guardFetch(original);
    await expect(guarded('https://api.example.net/sdk/v1/events')).rejects.toThrow(
      /network-guard.*api\.example\.net/,
    );
    expect(original).not.toHaveBeenCalled();
    expect(takeBlockedRequests()).toEqual([
      { api: 'fetch', url: 'https://api.example.net/sdk/v1/events' },
    ]);
  });

  it('reads the URL from a Request-like object and a URL', async () => {
    const guarded = guardFetch(
      vi.fn<(input: unknown, init?: unknown) => Promise<unknown>>(async () => 'ok'),
    );
    await expect(guarded({ url: 'https://example.com/a' })).rejects.toThrow(/network-guard/);
    await expect(guarded(new URL('https://example.com/b'))).rejects.toThrow(/network-guard/);
    expect(takeBlockedRequests().map(r => r.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('passes a local request through to the original', async () => {
    const original = vi.fn<(input: unknown, init?: unknown) => Promise<unknown>>(async () => 'ok');
    const guarded = guardFetch(original);
    await expect(guarded('/api/routes', { method: 'GET' })).resolves.toBe('ok');
    expect(original).toHaveBeenCalledWith('/api/routes', { method: 'GET' });
    expect(takeBlockedRequests()).toEqual([]);
  });
});

function fakeTarget() {
  const fetch = vi.fn<(input: unknown) => Promise<unknown>>(async () => 'ok');
  const open = vi.fn<(...args: unknown[]) => void>();
  const sendBeacon = vi.fn<(url: unknown, data?: unknown) => boolean>(() => true);
  class FakeXhr {
    readonly kind = 'fake-xhr';
  }
  (FakeXhr.prototype as unknown as { open: unknown }).open = open;
  const target = {
    fetch: fetch as unknown,
    XMLHttpRequest: FakeXhr as unknown as { prototype: { open: (...a: unknown[]) => void } },
    navigator: { sendBeacon: sendBeacon as unknown },
  };
  return { target, fetch, open, sendBeacon };
}

describe('installNetworkGuard', () => {
  it('guards fetch, XMLHttpRequest.open and sendBeacon', async () => {
    const { target, fetch, open, sendBeacon } = fakeTarget();
    installNetworkGuard(target);

    await expect(
      (target.fetch as (u: string) => Promise<unknown>)('https://x.example/'),
    ).rejects.toThrow(/network-guard/);
    expect(fetch).not.toHaveBeenCalled();

    const xhr = new (
      target.XMLHttpRequest as unknown as new () => { open: (...a: unknown[]) => void }
    )();
    expect(() => xhr.open('GET', 'https://y.example/')).toThrow(/network-guard/);
    expect(open).not.toHaveBeenCalled();
    xhr.open('GET', '/local');
    expect(open).toHaveBeenCalledWith('GET', '/local');

    const beacon = target.navigator.sendBeacon as (u: string, d?: unknown) => boolean;
    expect(beacon('https://z.example/')).toBe(false);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(beacon('/local', 'd')).toBe(true);
    expect(sendBeacon).toHaveBeenCalledWith('/local', 'd');

    expect(takeBlockedRequests()).toEqual([
      { api: 'fetch', url: 'https://x.example/' },
      { api: 'XMLHttpRequest', url: 'https://y.example/' },
      { api: 'sendBeacon', url: 'https://z.example/' },
    ]);
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
    await expect(fetch('https://api.example.net/sdk/v1/projects/bootstrap/')).rejects.toThrow(
      /network-guard/,
    );
    expect(takeBlockedRequests()).toHaveLength(1);
  });
});

describe('blockedRequestsMessage', () => {
  it('lists every refused request', () => {
    expect(
      blockedRequestsMessage([
        { api: 'fetch', url: 'https://a.example/' },
        { api: 'sendBeacon', url: 'https://b.example/' },
      ]),
    ).toBe(
      '[network-guard] 2 request(s) to a non-local host were attempted:\n' +
        '  fetch https://a.example/\n  sendBeacon https://b.example/',
    );
  });
});
