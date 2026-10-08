/**
 * Recent QR writes (v1.40.0): KV's listing lags a write by about a minute,
 * so a new code was missing from MCP `list_qrs`, the REST API and other tabs.
 * Each write records its id in `qr-recent:{domain}`, and the listing fetches
 * any recent id it lacks.
 */
import { env } from 'cloudflare:test';
import { type QRCode, QRCodeSchema, QRDesignSchema } from '@bifrost/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteQR, listQRs, putQR } from '../../src/kv/qr';
import {
  QR_RECENT_MAX,
  QR_RECENT_WINDOW_MS,
  qrRecentKey,
  readRecentQRWrites,
  recordRecentQRWrite,
} from '../../src/kv/qr-recent';
import { isRouteKey, qrDomainPrefix } from '../../src/kv/schema';
import { clearAllRoutes } from '../helpers';

const DOMAIN = 'links.example.com';

function makeQR(id: string): QRCode {
  const now = Date.now();
  return QRCodeSchema.parse({
    id,
    domain: DOMAIN,
    type: 'url',
    payload: { url: 'https://example.com' },
    design: QRDesignSchema.parse({}),
    createdAt: now,
    updatedAt: now,
    createdBy: 'test-user',
  });
}

/** The namespace with a listing that has not caught up: it lists none of `hidden`. */
function laggingList(hidden: Set<string>): KVNamespace {
  return new Proxy(env.ROUTES, {
    get(target, property) {
      if (property === 'list') {
        return async (options?: KVNamespaceListOptions) => {
          const result = await target.list(options);
          return { ...result, keys: result.keys.filter(key => !hidden.has(key.name)) };
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function clearAll(): Promise<void> {
  await clearAllRoutes();
  for (const key of (await env.ROUTES.list()).keys) await env.ROUTES.delete(key.name);
}

describe('recent QR writes', () => {
  beforeEach(clearAll);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lists a code the lagging listing lacks', async () => {
    await putQR(env.ROUTES, makeQR('listed'));
    await putQR(env.ROUTES, makeQR('fresh'));
    await recordRecentQRWrite(env.ROUTES, DOMAIN, 'fresh');
    const kv = laggingList(new Set([`${qrDomainPrefix(DOMAIN)}fresh`]));
    const { items, total } = await listQRs(kv, DOMAIN);
    expect(items.map(item => item.id).toSorted()).toEqual(['fresh', 'listed']);
    expect(total).toBe(2);
  });

  // v1.40.0 review: the merge is best effort; a failed read of a recent id
  // never fails the listing
  it('skips a recent id whose read fails, logging its class, and still lists', async () => {
    await putQR(env.ROUTES, makeQR('listed'));
    await putQR(env.ROUTES, makeQR('flaky'));
    await recordRecentQRWrite(env.ROUTES, DOMAIN, 'flaky');
    const flakyKey = `${qrDomainPrefix(DOMAIN)}flaky`;
    const lagging = laggingList(new Set([flakyKey]));
    const kv = new Proxy(lagging, {
      get(target, property) {
        if (property === 'get') {
          return async (key: string, ...rest: unknown[]) => {
            if (key === flakyKey) throw new Error(`KV GET failed: ${key}`);
            return Reflect.apply(target.get, target, [key, ...rest]);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { items } = await listQRs(kv, DOMAIN);
    expect(items.map(item => item.id)).toEqual(['listed']);
    expect(warn.mock.calls).toEqual([['[QR] A recent code could not be read: Error']]);
  });

  it('leaves out a recent code that has since been deleted', async () => {
    await putQR(env.ROUTES, makeQR('gone'));
    await recordRecentQRWrite(env.ROUTES, DOMAIN, 'gone');
    await deleteQR(env.ROUTES, DOMAIN, 'gone');
    const { items } = await listQRs(env.ROUTES, DOMAIN);
    expect(items).toEqual([]);
  });

  it('forgets a write after the window', async () => {
    const start = Date.now();
    await recordRecentQRWrite(env.ROUTES, DOMAIN, 'old', start);
    expect(await readRecentQRWrites(env.ROUTES, DOMAIN, start)).toEqual([{ id: 'old', at: start }]);
    expect(await readRecentQRWrites(env.ROUTES, DOMAIN, start + QR_RECENT_WINDOW_MS + 1)).toEqual(
      [],
    );
  });

  it('keeps one entry per id and at most the newest QR_RECENT_MAX', async () => {
    const now = Date.now();
    for (let i = 0; i < QR_RECENT_MAX + 5; i += 1) {
      await recordRecentQRWrite(env.ROUTES, DOMAIN, `id-${i}`, now + i);
    }
    await recordRecentQRWrite(env.ROUTES, DOMAIN, 'id-10', now + 500);
    const writes = await readRecentQRWrites(env.ROUTES, DOMAIN, now + 500);
    expect(writes).toHaveLength(QR_RECENT_MAX);
    expect(writes.filter(write => write.id === 'id-10')).toEqual([{ id: 'id-10', at: now + 500 }]);
    expect(writes.some(write => write.id === 'id-0')).toBe(false);
  });

  it('never throws when the key cannot be written, and reads a broken key as empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusing = new Proxy(env.ROUTES, {
      get(target, property) {
        if (property === 'put') {
          return async (key: string, ...rest: unknown[]) => {
            if (key === qrRecentKey(DOMAIN))
              throw new Error('KV PUT failed: 429 Too Many Requests');
            return Reflect.apply(target.put, target, [key, ...rest]);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(recordRecentQRWrite(refusing, DOMAIN, 'saved')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[QR] Recent write could not be recorded: Error');

    await env.ROUTES.put(qrRecentKey(DOMAIN), 'not json');
    expect(await readRecentQRWrites(env.ROUTES, DOMAIN)).toEqual([]);
  });

  it('keeps its key out of the route and QR prefixes', () => {
    const key = qrRecentKey(DOMAIN);
    expect(isRouteKey(key)).toBe(false);
    expect(key.startsWith('qr:')).toBe(false);
    expect(key.startsWith(`${DOMAIN}:`)).toBe(false);
  });
});
