// @vitest-environment node

/**
 * The transport guard (v1.47.0) is the network guard's guarantee: it is
 * checked here below every API wrapper, through a fresh happy-dom Window
 * whose fetch and XMLHttpRequest the setup file never wrapped, so only the
 * transport stands between them and the network. Each probe goes through a
 * real local HTTP server: a 302 to an outside address followed by happy-dom's
 * own fetch and by its XHR, and a cross-origin preflight to an outside
 * address. The outside address is a documentation range (TEST-NET-1), never
 * reachable, so even a failing guard would send nothing anywhere real.
 */

import childProcess from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { Window } from 'happy-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { blockedRequestsMessage, installNetworkGuard, takeBlockedRequests } from './network-guard';
import {
  connectTarget,
  isLoopbackAddress,
  isLoopbackHost,
  isNodeBinary,
  loopbackLookup,
} from './transport-guard';

const MARKER = 'tok-marker-9Rv';
const OUTSIDE = `http://192.0.2.1:9/${MARKER}?token=${MARKER}`;

let server: http.Server;
let origin = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url?.startsWith('/redirect')) {
      response.writeHead(302, { location: OUTSIDE });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  // Refusals provoked on purpose here must not trip the setup-file hook.
  takeBlockedRequests();
});

/** A happy-dom window at the local server's origin, with no API wrapper. */
function freshWindow(): Window {
  return new Window({ url: `${origin}/` });
}

/** The refusals recorded so far, and that none names the outside URL. */
function socketRefusals(): unknown[] {
  const recorded = takeBlockedRequests();
  expect(blockedRequestsMessage(recorded)).not.toContain(MARKER);
  expect(blockedRequestsMessage(recorded)).not.toContain('192.0.2.1');
  return recorded.filter(entry => entry.api === 'socket');
}

/** The host a connect call targets, or `path` for a local pipe. */
function targetOf(args: unknown[]): string {
  const target = connectTarget(args);
  return target.kind === 'host' ? target.host : 'path';
}

describe('isLoopbackHost and connectHost', () => {
  it.each([
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '127.8.9.10',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ])('%s is loopback', host => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    '192.0.2.1',
    'example.com',
    '10.0.0.1',
    '::ffff:192.0.2.1',
    '2001:db8::1',
    'localhost.example',
  ])('%s is not loopback', host => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it('a loopback name is not a loopback address', () => {
    expect(isLoopbackAddress('localhost')).toBe(false);
    expect(isLoopbackAddress('app.localhost')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
  });

  it('reads every connect form; only a non-empty path is a local pipe', () => {
    expect(targetOf([{ host: 'example.com', port: 80 }])).toBe('example.com');
    expect(targetOf([[{ host: 'example.com', port: 443 }, () => {}]])).toBe('example.com');
    expect(targetOf([80, 'example.com'])).toBe('example.com');
    expect(targetOf(['80', 'example.com'])).toBe('example.com');
    expect(targetOf([80])).toBe('localhost');
    expect(targetOf([{ port: 80 }])).toBe('localhost');
    expect(targetOf([{ path: '/tmp/sock' }])).toBe('path');
    expect(targetOf(['/tmp/sock'])).toBe('path');
    // An empty path is not a pipe: the host decides
    expect(targetOf([{ path: '', host: 'example.com', port: 80 }])).toBe('example.com');
    expect(targetOf(['', 'example.com'])).toBe('example.com');
  });

  it('answers a loopback name itself, by the family asked for, and refuses any other', () => {
    expect(loopbackLookup('app.localhost', undefined)).toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);
    expect(loopbackLookup('app.localhost', 6)).toEqual([{ address: '::1', family: 6 }]);
    expect(loopbackLookup('localhost', { family: 4 })).toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);
    expect(loopbackLookup('localhost', { all: true })).toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    expect(loopbackLookup('127.0.0.5', undefined)).toEqual([{ address: '127.0.0.5', family: 4 }]);
    expect(loopbackLookup('example.com', undefined)).toBeNull();
  });

  it("names only this Node binary as happy-dom's child", () => {
    expect(isNodeBinary(process.execPath)).toBe(true);
    expect(isNodeBinary('git')).toBe(false);
  });
});

describe('the transport resolves loopback names itself', () => {
  it("connects to app.localhost without asking any resolver, the socket's own lookup included", async () => {
    const resolver = vi.fn<net.LookupFunction>();
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: 'app.localhost', port, lookup: resolver }, () => {
        expect(socket.remoteAddress).toBe('127.0.0.1');
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(takeBlockedRequests()).toEqual([]);
  });

  it('dns.lookup answers app.localhost by family, never asking the system resolver', async () => {
    const answer = await new Promise<[unknown, unknown]>((resolve, reject) => {
      dns.lookup('app.localhost', { family: 6 }, (error, address, family) =>
        error ? reject(error) : resolve([address, family]),
      );
    });
    expect(answer).toEqual(['::1', 6]);
    await expect(dns.promises.lookup('app.localhost')).resolves.toEqual({
      address: '127.0.0.1',
      family: 4,
    });
  });

  it('a socket reporting a non-loopback resolution is destroyed', async () => {
    const port = (server.address() as AddressInfo).port;
    const socket = net.connect({ host: '127.0.0.1', port });
    const error = await new Promise<Error>(resolve => {
      socket.on('error', resolve);
      socket.emit('lookup', null, '192.0.2.1', 4, 'example.com');
    });
    expect(error.message).toMatch(/socket: non-loopback address is blocked/);
    expect(socket.destroyed).toBe(true);
    expect(socketRefusals()).toHaveLength(1);
  });

  it('a socket attempting a non-loopback address is destroyed', async () => {
    const port = (server.address() as AddressInfo).port;
    const socket = net.connect({ host: '127.0.0.1', port });
    const error = await new Promise<Error>(resolve => {
      socket.on('error', resolve);
      socket.emit('connectionAttempt', '192.0.2.1', 9, 4);
    });
    expect(error.message).toMatch(/non-loopback address/);
    expect(socketRefusals()).toHaveLength(1);
  });
});

describe('the transport refuses', () => {
  it('a raw TCP connection to an outside address, failing the socket', async () => {
    const error = await new Promise<Error>(resolve => {
      net.connect({ host: '192.0.2.1', port: 9 }).on('error', resolve);
    });
    expect(error.message).toMatch(/socket: non-loopback address is blocked/);
    expect(error.message).not.toContain('192.0.2.1');
    expect(socketRefusals()).toHaveLength(1);
  });

  it('a connection to loopback is allowed', async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      http
        .get(`${origin}/ok`, response => {
          let body = '';
          response.on('data', chunk => (body += String(chunk)));
          response.on('end', () => resolve(body));
        })
        .on('error', reject);
    });
    expect(answer).toBe('ok');
    expect(takeBlockedRequests()).toEqual([]);
  });

  it('a DNS lookup of an outside name, by callback and by promise', async () => {
    const callbackError = await new Promise<Error | null>(resolve => {
      dns.lookup('example.com', error => resolve(error));
    });
    expect(callbackError?.message).toMatch(/dns: non-loopback name is blocked/);
    await expect(dns.promises.lookup('example.com')).rejects.toThrow(/non-loopback name/);
    expect(takeBlockedRequests()).toEqual([
      { api: 'dns', reason: 'non-loopback name' },
      { api: 'dns', reason: 'non-loopback name' },
    ]);
    await expect(dns.promises.lookup('localhost')).resolves.toBeDefined();
  });

  it("happy-dom's own fetch following a local 302 to an outside address", async () => {
    const window = freshWindow();
    try {
      await expect(window.fetch(`${origin}/redirect`)).rejects.toBeDefined();
    } finally {
      await window.happyDOM.close();
    }
    expect(socketRefusals().length).toBeGreaterThanOrEqual(1);
  });

  it("happy-dom's cross-origin preflight to an outside address", async () => {
    const window = freshWindow();
    try {
      await expect(
        window.fetch(OUTSIDE, { method: 'PUT', headers: { 'X-Custom': '1' }, body: 'x' }),
      ).rejects.toBeDefined();
    } finally {
      await window.happyDOM.close();
    }
    expect(socketRefusals().length).toBeGreaterThanOrEqual(1);
  });

  it("happy-dom's XMLHttpRequest following a local 302 to an outside address", async () => {
    const window = freshWindow();
    try {
      const xhr = new window.XMLHttpRequest();
      const done = new Promise<number>(resolve => {
        xhr.addEventListener('loadend', () => resolve(xhr.status));
      });
      xhr.open('GET', `${origin}/redirect`);
      xhr.send();
      expect(await done).not.toBe(200);
    } finally {
      await window.happyDOM.close();
    }
    expect(socketRefusals().length).toBeGreaterThanOrEqual(1);
  });

  it("happy-dom's synchronous XHR never launches its child Node process", async () => {
    const window = freshWindow();
    try {
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', `${origin}/ok`, false);
      // happy-dom catches the launch's refusal itself; the request fails
      xhr.send();
      expect(xhr.status).not.toBe(200);
    } finally {
      await window.happyDOM.close();
    }
    expect(takeBlockedRequests()).toContainEqual({ api: 'child_process', reason: 'child process' });
  });
});

describe('the network guard refuses a synchronous XHR before it is sent', () => {
  it('open(…, false) throws at once, so no child launch is attempted', () => {
    const launched = vi.spyOn(childProcess, 'execFileSync');
    const window = freshWindow();
    try {
      installNetworkGuard(window);
      const xhr = new window.XMLHttpRequest();
      expect(() => xhr.open('GET', `${origin}/ok`, false)).toThrow(
        /XMLHttpRequest: synchronous request is blocked/,
      );
      expect(launched).not.toHaveBeenCalled();
    } finally {
      launched.mockRestore();
      void window.happyDOM.close();
    }
    expect(takeBlockedRequests()).toEqual([
      { api: 'XMLHttpRequest', reason: 'synchronous request' },
    ]);
  });
});
