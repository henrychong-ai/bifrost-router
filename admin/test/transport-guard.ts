// Test-only transport guard (v1.47.0): the network guard's guarantee. Every
// TCP or TLS connection the test process opens goes through
// `net.Socket.prototype.connect` (Node's http and https agents, `tls.connect`,
// the built-in fetch's connector and happy-dom's own fetch, XHR, preflight and
// resource loader all do), so the rule is enforced there: a connection to an
// address that is not loopback is refused before any packet is sent, and the
// socket fails with an error, as a refused connection would. A unix socket or
// pipe path is local. `dns.lookup` and `dns.promises.lookup` refuse a name
// that is not loopback too, so not even a DNS query leaves for it. A refusal
// records the API and a fixed reason only (./network-guard.ts), never the
// host, port or URL.

import dns from 'node:dns';
import net from 'node:net';
import { refuse } from './network-guard';

/** Whether `host` (a name or an address) is this machine. */
export function isLoopbackHost(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '::1' || name === '0:0:0:0:0:0:0:1') return true;
  const v4 = name.replace(/^::ffff:/, '');
  return net.isIPv4(v4) && v4.startsWith('127.');
}

/**
 * The host a `Socket#connect` call targets, or null for a local path (a unix
 * socket or pipe). Node's own callers pass a normalised `[options, cb]`
 * array; the public forms are `(options[, cb])`, `(path[, cb])` and
 * `(port[, host][, cb])`. No host means localhost, as for Node itself.
 */
export function connectHost(args: readonly unknown[]): string | null {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first && typeof first === 'object') {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === 'string') return null;
    return typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
}

const INSTALLED = Symbol.for('bifrost.test.transportGuard');

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
type Lookup = (hostname: string, ...rest: unknown[]) => unknown;

/** Patches `net.Socket.prototype.connect`, `dns.lookup` and `dns.promises.lookup`, once. */
export function installTransportGuard(): void {
  const marked = net.Socket.prototype as net.Socket & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;

  const connect = net.Socket.prototype.connect as unknown as Connect;
  const guardedConnect: Connect = function guardedConnect(...args) {
    const host = connectHost(args);
    if (host === null || isLoopbackHost(host)) return connect.apply(this, args);
    const error = refuse('socket', 'non-loopback address');
    // Fails the socket as a refused connection would, asynchronously, so
    // every caller's own error path (an http request, a fetch) handles it
    process.nextTick(() => this.destroy(error));
    return this;
  };
  (net.Socket.prototype as { connect: unknown }).connect = guardedConnect;

  const lookup = dns.lookup as unknown as Lookup;
  const guardedLookup: Lookup = (hostname, ...rest) => {
    if (isLoopbackHost(hostname)) return lookup(hostname, ...rest);
    const error = refuse('dns', 'non-loopback name');
    const callback = rest.findLast(arg => typeof arg === 'function') as
      | ((err: Error) => void)
      | undefined;
    if (callback) process.nextTick(() => callback(error));
    return undefined;
  };
  (dns as { lookup: unknown }).lookup = guardedLookup;

  const promisesLookup = dns.promises.lookup as unknown as (
    hostname: string,
    ...rest: unknown[]
  ) => Promise<unknown>;
  (dns.promises as { lookup: unknown }).lookup = (hostname: string, ...rest: unknown[]) =>
    isLoopbackHost(hostname)
      ? promisesLookup(hostname, ...rest)
      : Promise.reject(refuse('dns', 'non-loopback name'));
}
