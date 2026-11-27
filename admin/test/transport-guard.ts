// Test-only transport guard (v1.47.0): the network guard's guarantee for
// TCP and TLS. Every TCP or TLS connection the test process opens goes
// through `net.Socket.prototype.connect` (Node's http and https agents,
// `tls.connect`, the built-in fetch's connector and happy-dom's own fetch,
// asynchronous XHR, preflight and resource loader all do), so the rule is
// enforced there, by address:
//
// - a loopback address (127.0.0.0/8, ::1, ::ffff:127.x) is connected to;
// - a loopback name (`localhost`, `*.localhost`) is replaced by a loopback
//   address literal before Node sees it (`::1` when IPv6 is asked for, else
//   127.0.0.1), so no resolver, Node's or a socket's own `lookup` option, is
//   ever asked for it;
// - any other host is refused before any packet is sent, and the socket fails
//   as a refused connection would;
// - a non-empty unix socket or pipe path is local;
// - a guarded socket is also destroyed if it ever reports (its `lookup` or
//   `connectionAttempt` event) an address that is not loopback.
//
// `dns.lookup` and `dns.promises.lookup` answer a loopback name or address
// themselves, never asking the system resolver, and refuse any other name.
// NOT patched: `dns.resolve*` and `dns.Resolver`, which query DNS servers
// directly (c-ares); no dashboard code uses them. Synchronous XHR runs in a
// child process this guard cannot see, so the network guard refuses it
// before the child starts (./network-guard.ts), and `child_process.
// execFileSync` refuses to launch a Node child (happy-dom's SyncFetch
// launcher) in case anything gets past that.
//
// What this guard records is the API and a fixed reason only
// (./network-guard.ts), never a host, port or URL. The error a library shows
// for the failed connection is its own: happy-dom's fetch rejection text, for
// one, can include the URL it was fetching.

import childProcess from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { refuse } from './network-guard';

function normaliseHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

/** Whether `host` is a loopback name: `localhost` or a `*.localhost` name. */
export function isLoopbackName(host: string): boolean {
  const name = normaliseHost(host);
  return name === 'localhost' || name.endsWith('.localhost');
}

/** Whether `address` is a loopback IP literal: 127.0.0.0/8, ::1 or ::ffff:127.x. */
export function isLoopbackAddress(address: string): boolean {
  const name = normaliseHost(address);
  if (net.isIPv6(name) && (name === '::1' || name === '0:0:0:0:0:0:0:1')) return true;
  const v4 = name.replace(/^::ffff:/, '');
  return net.isIPv4(v4) && v4.startsWith('127.');
}

/** Whether `host` (a name or an address) is this machine. */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackName(host) || isLoopbackAddress(host);
}

/** The loopback literal for an IP family request: `::1` for 6, else 127.0.0.1. */
function loopbackFor(family: unknown): { address: string; family: 4 | 6 } {
  return family === 6 || family === 'IPv6'
    ? { address: '::1', family: 6 }
    : { address: '127.0.0.1', family: 4 };
}

type ConnectTarget =
  | { kind: 'path' }
  | { kind: 'host'; host: string; family: unknown; form: 'normalised' | 'options' | 'port' };

/**
 * What a `Socket#connect` call targets. Node's own callers pass a normalised
 * `[options, cb]` array; the public forms are `(options[, cb])`,
 * `(path[, cb])` and `(port[, host][, cb])`. Only a non-empty path is a local
 * pipe; no host means localhost, as for Node itself.
 */
export function connectTarget(args: readonly unknown[]): ConnectTarget {
  const normalised = Array.isArray(args[0]);
  const first: unknown = normalised ? (args[0] as unknown[])[0] : args[0];
  if (first && typeof first === 'object') {
    const options = first as { path?: unknown; host?: unknown; family?: unknown };
    if (typeof options.path === 'string' && options.path !== '') return { kind: 'path' };
    const host =
      typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost';
    return {
      kind: 'host',
      host,
      family: options.family,
      form: normalised ? 'normalised' : 'options',
    };
  }
  if (typeof first === 'string' && first !== '' && !/^\d+$/.test(first)) return { kind: 'path' };
  const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
  return { kind: 'host', host, family: undefined, form: 'port' };
}

/** The connect arguments with the host replaced by `address`. */
function withHost(args: unknown[], target: ConnectTarget, address: string): unknown[] {
  if (target.kind !== 'host') return args;
  if (target.form === 'normalised') {
    // Node marks its normalised array with a private symbol, so the array
    // itself is kept and only its options entry is replaced
    const normalised = args[0] as unknown[];
    normalised[0] = { ...(normalised[0] as object), host: address };
    return args;
  }
  if (target.form === 'options')
    return [{ ...(args[0] as object), host: address }, ...args.slice(1)];
  const copy = [...args];
  copy[1] = address;
  return copy;
}

/** Destroys `socket` if it ever reports an address that is not loopback. */
function watchAddresses(socket: net.Socket): void {
  const check = (address: unknown) => {
    if (typeof address === 'string' && !isLoopbackAddress(address)) {
      socket.destroy(refuse('socket', 'non-loopback address'));
    }
  };
  socket.on('lookup', (error: Error | null, address: unknown) => {
    if (!error) check(address);
  });
  socket.on('connectionAttempt', (address: unknown) => check(address));
}

/**
 * The guarded `dns.lookup` answer for `hostname`: a loopback name or address
 * answered here (never by the system resolver), anything else refused.
 */
export function loopbackLookup(
  hostname: string,
  options: unknown,
): { address: string; family: 4 | 6 }[] | null {
  const opts = typeof options === 'number' ? { family: options } : (options ?? {});
  const { family, all } = opts as { family?: unknown; all?: unknown };
  if (isLoopbackAddress(hostname)) {
    const address = normaliseHost(hostname);
    return [{ address, family: net.isIPv6(address) ? 6 : 4 }];
  }
  if (!isLoopbackName(hostname)) return null;
  if (all === true && (family === undefined || family === 0)) {
    return [loopbackFor(4), loopbackFor(6)];
  }
  return [loopbackFor(family)];
}

// Never calls the system resolver: a loopback name or address is answered
// here, anything else is refused
function guardedLookup(hostname: string, ...rest: unknown[]): void {
  const callback = rest.findLast(arg => typeof arg === 'function') as
    | ((err: Error | null, address?: unknown, family?: number) => void)
    | undefined;
  const options = typeof rest[0] === 'function' ? undefined : rest[0];
  const answer = loopbackLookup(hostname, options);
  if (!callback) return;
  if (answer === null) {
    const error = refuse('dns', 'non-loopback name');
    process.nextTick(() => callback(error));
    return;
  }
  const all = (options as { all?: unknown } | undefined)?.all === true;
  const first = answer[0] ?? loopbackFor(4);
  process.nextTick(() =>
    all ? callback(null, answer) : callback(null, first.address, first.family),
  );
}

const INSTALLED = Symbol.for('bifrost.test.transportGuard');

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

/** Whether `file` names this Node binary: the program happy-dom's SyncFetch runs. */
export function isNodeBinary(file: unknown): boolean {
  return typeof file === 'string' && (file === process.execPath || file === process.argv[0]);
}

/**
 * Patches `net.Socket.prototype.connect`, `dns.lookup`, `dns.promises.lookup`
 * and `child_process.execFileSync` (a Node child only), once.
 */
export function installTransportGuard(): void {
  const marked = net.Socket.prototype as net.Socket & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;

  const connect = net.Socket.prototype.connect as unknown as Connect;
  const guardedConnect: Connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (target.kind === 'path') return connect.apply(this, args);
    if (isLoopbackAddress(target.host)) {
      watchAddresses(this);
      return connect.apply(this, args);
    }
    if (isLoopbackName(target.host)) {
      watchAddresses(this);
      return connect.apply(this, withHost(args, target, loopbackFor(target.family).address));
    }
    const error = refuse('socket', 'non-loopback address');
    // Fails the socket as a refused connection would, asynchronously, so
    // every caller's own error path (an http request, a fetch) handles it
    process.nextTick(() => this.destroy(error));
    return this;
  };
  (net.Socket.prototype as { connect: unknown }).connect = guardedConnect;

  (dns as { lookup: unknown }).lookup = guardedLookup;

  // happy-dom's SyncFetch runs a synchronous request in a child Node process,
  // whose sockets this guard never sees: launching one is refused
  const execFileSync = childProcess.execFileSync as unknown as (...args: unknown[]) => unknown;
  (childProcess as { execFileSync: unknown }).execFileSync = (
    file: unknown,
    ...rest: unknown[]
  ) => {
    if (isNodeBinary(file)) throw refuse('child_process', 'child process');
    return execFileSync(file, ...rest);
  };

  (dns.promises as { lookup: unknown }).lookup = (hostname: string, options?: unknown) => {
    const answer = loopbackLookup(hostname, options);
    if (answer === null) return Promise.reject(refuse('dns', 'non-loopback name'));
    const all = (options as { all?: unknown } | undefined)?.all === true;
    return Promise.resolve(all ? answer : answer[0]);
  };
}
