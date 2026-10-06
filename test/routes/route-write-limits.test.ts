/**
 * Write-time limits on route records (v1.37.2). A route record is one line of
 * the nightly backup archive, whose verifier refuses a line over 1 MiB, and a
 * route key is a KV key, which KV caps at 512 bytes. Every variable-length
 * field is capped, the whole stored record is capped at 64 KiB, and every write
 * that composes a key checks it, all before anything is written. The record
 * checked is the record stored: after the merge, the path normalisation and
 * the timestamps.
 */

import { env } from 'cloudflare:test';
import {
  MAX_CACHE_CONTROL_LENGTH,
  MAX_HOST_HEADER_LENGTH,
  MAX_ROUTE_KEY_BYTES,
  MAX_ROUTE_RECORD_BYTES,
  MAX_ROUTE_TARGET_LENGTH,
} from '@bifrost/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECORD_LINE_BYTES } from '../../src/backup/integrity';
import {
  createRoute,
  migrateRoute,
  ROUTE_WRITE_REFUSALS,
  RouteWriteRefusedError,
  seedRoutes,
  serializeCheckedRoute,
  transferRoute,
  updateRoute,
} from '../../src/kv/routes';
import { fitsKvKey, routeKey } from '../../src/kv/schema';
import type { KVRouteConfig } from '../../src/types';
import { clearAllRoutes, makeAdminRequest } from '../helpers';

const DOMAIN = 'links.example.com';
const utf8 = new TextEncoder();

/** A path whose route key on `domain` is exactly `bytes` UTF-8 bytes, with two-byte characters. */
function pathForKeyBytes(bytes: number, domain = DOMAIN): string {
  const pathBytes = bytes - utf8.encode(`${domain}:`).byteLength;
  const doubles = Math.floor((pathBytes - 1) / 2);
  const path = `/${'é'.repeat(doubles)}${'a'.repeat(pathBytes - 1 - doubles * 2)}`;
  expect(utf8.encode(routeKey(domain, path)).byteLength).toBe(bytes);
  return path;
}

function post(path: string, body: unknown): Promise<Response> {
  return makeAdminRequest(path, { method: 'POST', body: JSON.stringify(body) });
}

function put(path: string, body: unknown): Promise<Response> {
  return makeAdminRequest(path, { method: 'PUT', body: JSON.stringify(body) });
}

const redirect = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  type: 'redirect',
  target: 'https://dest.example.net/',
  ...extra,
});

/** The stored record at `domain` and `path`; none can exist under a key KV refuses. */
async function stored(domain: string, path: string): Promise<string | null> {
  const key = routeKey(domain, path);
  return fitsKvKey(key) ? env.ROUTES.get(key) : null;
}

/** A stored legacy record of `bytes` serialised bytes, with a short updatedAt. */
async function storeLegacy(path: string, bytes: number): Promise<void> {
  const base = { ...redirect(path), enabled: true, createdAt: 1, updatedAt: 1, legacyNote: '' };
  const padding = bytes - JSON.stringify(base).length;
  const record = { ...base, legacyNote: 'x'.repeat(padding) };
  expect(utf8.encode(JSON.stringify(record)).byteLength).toBe(bytes);
  await env.ROUTES.put(routeKey(DOMAIN, path), JSON.stringify(record));
}

/** The fixed refusal a write rejected with, or `written`. */
function refusal(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'written',
    (error: unknown) => (error instanceof RouteWriteRefusedError ? error.refusal : String(error)),
  );
}

describe('route write limits', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it('keeps the record cap far below the backup line limit', () => {
    expect(MAX_ROUTE_RECORD_BYTES * 16).toBeLessThanOrEqual(MAX_RECORD_LINE_BYTES);
    expect(MAX_ROUTE_KEY_BYTES).toBe(512);
    // Every field at its cap still fits the record cap many times over
    expect(
      MAX_ROUTE_TARGET_LENGTH * 4 + MAX_HOST_HEADER_LENGTH + MAX_CACHE_CONTROL_LENGTH,
    ).toBeLessThan(MAX_ROUTE_RECORD_BYTES);
  });

  describe('field caps on create', () => {
    it.each([
      ['target', { target: `https://dest.example.net/${'a'.repeat(MAX_ROUTE_TARGET_LENGTH)}` }],
      ['hostHeader', { type: 'proxy', hostHeader: 'h'.repeat(MAX_HOST_HEADER_LENGTH + 1) }],
      ['cacheControl', { cacheControl: 'c'.repeat(MAX_CACHE_CONTROL_LENGTH + 1) }],
    ])('refuses an over-long %s, writing nothing', async (_field, extra) => {
      const response = await post(`/routes?domain=${DOMAIN}`, redirect('/capped', extra));
      expect(response.status).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe('Validation failed');
      expect(await stored(DOMAIN, '/capped')).toBeNull();
    });

    it('accepts every field at its cap', async () => {
      const response = await post(
        `/routes?domain=${DOMAIN}`,
        redirect('/at-cap', {
          type: 'proxy',
          target: `https://dest.example.net/${'a'.repeat(MAX_ROUTE_TARGET_LENGTH - 25)}`,
          hostHeader: 'h'.repeat(MAX_HOST_HEADER_LENGTH),
          cacheControl: 'c'.repeat(MAX_CACHE_CONTROL_LENGTH),
        }),
      );
      expect(response.status).toBe(201);
    });
  });

  describe('route key byte limit', () => {
    it('accepts a key of exactly 512 bytes and refuses 513 on create', async () => {
      const fits = pathForKeyBytes(512);
      expect((await post(`/routes?domain=${DOMAIN}`, redirect(fits))).status).toBe(201);
      const over = pathForKeyBytes(513);
      const response = await post(`/routes?domain=${DOMAIN}`, redirect(over));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: ROUTE_WRITE_REFUSALS.keyTooLong,
      });
      expect(await stored(DOMAIN, over)).toBeNull();
    });

    it('refuses a seed batch holding one key over the limit, writing none of it', async () => {
      const response = await post(`/routes/seed?domain=${DOMAIN}`, {
        routes: [redirect('/fine'), redirect(pathForKeyBytes(513))],
      });
      expect(response.status).toBe(400);
      // The refusal names the offending path
      expect(await response.json()).toEqual({
        success: false,
        error: ROUTE_WRITE_REFUSALS.keyTooLong,
        path: pathForKeyBytes(513),
      });
      expect(await stored(DOMAIN, '/fine')).toBeNull();
    });

    it('refuses a migrate to a path whose key is over the limit, keeping the route', async () => {
      await post(`/routes?domain=${DOMAIN}`, redirect('/old'));
      const newPath = pathForKeyBytes(513);
      const response = await makeAdminRequest(
        `/routes/migrate?oldPath=/old&newPath=${encodeURIComponent(newPath)}&domain=${DOMAIN}`,
        { method: 'POST' },
      );
      expect(response.status).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe(
        ROUTE_WRITE_REFUSALS.keyTooLong,
      );
      expect(await stored(DOMAIN, '/old')).not.toBeNull();
    });

    it('refuses a transfer to a longer domain the key no longer fits, keeping the route', async () => {
      const path = pathForKeyBytes(512);
      expect((await post(`/routes?domain=${DOMAIN}`, redirect(path))).status).toBe(201);
      const response = await post('/routes/transfer', {
        path,
        fromDomain: DOMAIN,
        toDomain: 'secondary.example.net',
      });
      expect(response.status).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe(
        ROUTE_WRITE_REFUSALS.keyTooLong,
      );
      expect(await stored(DOMAIN, path)).not.toBeNull();
      expect(await stored('secondary.example.net', path)).toBeNull();
    });

    it('skips a lower-casing that would take a key over the limit', async () => {
      // 'İ' is two bytes; lower-cased it becomes three
      const path = `/${'İ'.repeat(200)}`;
      await env.ROUTES.put(routeKey(DOMAIN, path), JSON.stringify(redirect(path)));
      const response = await post('/routes/normalize-case', {});
      expect(response.status).toBe(200);
      const body = await response.json<{ data: { migrated: number; errors: string[] } }>();
      expect(body.data.migrated).toBe(0);
      expect(body.data.errors.join('\n')).toContain(ROUTE_WRITE_REFUSALS.keyTooLong);
      expect(await stored(DOMAIN, path)).not.toBeNull();
    });
  });

  describe('the exact stored record', () => {
    it('refuses an update whose new updatedAt takes the record past 64 KiB', async () => {
      await storeLegacy('/big', MAX_ROUTE_RECORD_BYTES);
      const before = await stored(DOMAIN, '/big');
      const response = await put(`/routes?path=/big&domain=${DOMAIN}`, { type: 'redirect' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: ROUTE_WRITE_REFUSALS.recordTooLarge,
      });
      expect(await stored(DOMAIN, '/big')).toBe(before);
    });

    // An enable/disable-only patch skips the size check, so an oversized
    // legacy route can always be switched off; any other patch keeps it
    it('lets an oversized legacy route be disabled, and nothing else', async () => {
      await storeLegacy('/oversized', 70 * 1024);
      const disabled = await put(`/routes?path=/oversized&domain=${DOMAIN}`, { enabled: false });
      expect(disabled.status).toBe(200);
      const record = JSON.parse((await stored(DOMAIN, '/oversized')) ?? '{}') as KVRouteConfig;
      expect(record.enabled).toBe(false);
      const mixed = await put(`/routes?path=/oversized&domain=${DOMAIN}`, {
        enabled: false,
        cacheControl: 'x',
      });
      expect(mixed.status).toBe(400);
      expect((await mixed.json<{ error: string }>()).error).toBe(
        ROUTE_WRITE_REFUSALS.recordTooLarge,
      );
    });

    it('accepts an update that lands exactly on 64 KiB, and stores what it measured', async () => {
      // updatedAt grows from one digit to thirteen
      await storeLegacy('/edge', MAX_ROUTE_RECORD_BYTES - 12);
      const response = await put(`/routes?path=/edge&domain=${DOMAIN}`, { type: 'redirect' });
      expect(response.status).toBe(200);
      const written = await stored(DOMAIN, '/edge');
      expect(utf8.encode(written ?? '').byteLength).toBe(MAX_ROUTE_RECORD_BYTES);
    });

    it('lets a legacy route over a field cap be toggled, refusing only a patch over a cap', async () => {
      const record = {
        ...redirect('/legacy', { type: 'proxy' }),
        target: `https://dest.example.net/${'a'.repeat(MAX_ROUTE_TARGET_LENGTH)}`,
        hostHeader: 'h'.repeat(300),
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      };
      await env.ROUTES.put(routeKey(DOMAIN, '/legacy'), JSON.stringify(record));
      const toggled = await put(`/routes?path=/legacy&domain=${DOMAIN}`, { enabled: false });
      expect(toggled.status).toBe(200);
      const stored1 = JSON.parse((await stored(DOMAIN, '/legacy')) ?? '{}') as KVRouteConfig;
      expect(stored1.enabled).toBe(false);
      expect(stored1.target).toBe(record.target);

      // A patch that SETS an over-cap field is refused, at the API and at the writer
      const viaApi = await put(`/routes?path=/legacy&domain=${DOMAIN}`, {
        hostHeader: 'h'.repeat(MAX_HOST_HEADER_LENGTH + 1),
      });
      expect(viaApi.status).toBe(400);
      expect(
        await refusal(
          updateRoute(env.ROUTES, DOMAIN, '/legacy', {
            cacheControl: 'c'.repeat(MAX_CACHE_CONTROL_LENGTH + 1),
          }),
        ),
      ).toBe(ROUTE_WRITE_REFUSALS.cacheControl);
    });

    // The guarantee lives in the KV writers themselves, on the exact
    // record and key, whatever the handler checked before
    it('refuses at every KV writer, on the record it would store', async () => {
      const long = pathForKeyBytes(513);
      const input = redirect(long) as Parameters<typeof createRoute>[2];
      expect(await refusal(createRoute(env.ROUTES, DOMAIN, input))).toBe(
        ROUTE_WRITE_REFUSALS.keyTooLong,
      );
      expect(await refusal(seedRoutes(env.ROUTES, DOMAIN, [input]))).toBe(
        ROUTE_WRITE_REFUSALS.keyTooLong,
      );

      // A legacy record too large to store again: moving it is refused too
      await storeLegacy('/huge', MAX_ROUTE_RECORD_BYTES + 100);
      expect(await refusal(updateRoute(env.ROUTES, DOMAIN, '/huge', { type: 'redirect' }))).toBe(
        ROUTE_WRITE_REFUSALS.recordTooLarge,
      );
      expect(await refusal(migrateRoute(env.ROUTES, DOMAIN, '/huge', '/moved'))).toBe(
        ROUTE_WRITE_REFUSALS.recordTooLarge,
      );
      expect(
        await refusal(transferRoute(env.ROUTES, DOMAIN, 'secondary.example.net', '/huge')),
      ).toBe(ROUTE_WRITE_REFUSALS.recordTooLarge);
      expect(await stored(DOMAIN, '/huge')).not.toBeNull();
      expect(await stored(DOMAIN, '/moved')).toBeNull();
      expect(await stored('secondary.example.net', '/huge')).toBeNull();
    });

    it('refuses a migrate or transfer of an oversized record through the API', async () => {
      await storeLegacy('/huge', MAX_ROUTE_RECORD_BYTES + 100);
      const migrate = await makeAdminRequest(
        `/routes/migrate?oldPath=/huge&newPath=/moved&domain=${DOMAIN}`,
        { method: 'POST' },
      );
      expect(migrate.status).toBe(400);
      expect((await migrate.json<{ error: string }>()).error).toBe(
        ROUTE_WRITE_REFUSALS.recordTooLarge,
      );
      const transfer = await post('/routes/transfer', {
        path: '/huge',
        fromDomain: DOMAIN,
        toDomain: 'secondary.example.net',
      });
      expect(transfer.status).toBe(400);
      expect(await stored(DOMAIN, '/huge')).not.toBeNull();
    });

    it('skips a lower-casing of an oversized record, keeping it', async () => {
      await storeLegacy('/HUGE', MAX_ROUTE_RECORD_BYTES + 100);
      const response = await post('/routes/normalize-case', {});
      const body = await response.json<{ data: { migrated: number; errors: string[] } }>();
      expect(body.data.migrated).toBe(0);
      expect(body.data.errors.join('\n')).toContain(ROUTE_WRITE_REFUSALS.recordTooLarge);
      expect(await stored(DOMAIN, '/HUGE')).not.toBeNull();
      expect(await stored(DOMAIN, '/huge')).toBeNull();
    });

    it('checks the record, its fields and its key in one place', () => {
      const route = {
        ...redirect('/unit'),
        createdAt: 1,
        updatedAt: 1,
      } as unknown as KVRouteConfig;
      expect(serializeCheckedRoute(routeKey(DOMAIN, '/unit'), route)).toBe(JSON.stringify(route));
      for (const [record, expected] of [
        [
          { ...route, target: 'a'.repeat(MAX_ROUTE_TARGET_LENGTH + 1) },
          ROUTE_WRITE_REFUSALS.target,
        ],
        [
          { ...route, cacheControl: 'c'.repeat(MAX_CACHE_CONTROL_LENGTH + 1) },
          ROUTE_WRITE_REFUSALS.cacheControl,
        ],
        [
          { ...route, note: 'x'.repeat(MAX_ROUTE_RECORD_BYTES) },
          ROUTE_WRITE_REFUSALS.recordTooLarge,
        ],
      ] as const) {
        expect(() =>
          serializeCheckedRoute(routeKey(DOMAIN, '/unit'), record as KVRouteConfig),
        ).toThrow(expected);
      }
    });
  });
});

describe('seed duplicates within one batch', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it.each([
    ['exact', '/same', '/same'],
    ['case-folded', '/Same', '/same'],
    ['percent-encoded', '/same', '/s%61me'],
  ])(
    'keeps the first of two %s duplicates and counts the second skipped',
    async (_label, first, second) => {
      const response = await post(`/routes/seed?domain=${DOMAIN}`, {
        routes: [
          redirect(first, { target: 'https://dest.example.net/first' }),
          redirect(second, { target: 'https://dest.example.net/second' }),
        ],
      });
      expect(response.status).toBe(200);
      const body = await response.json<{ data: { created: number; skipped: number } }>();
      expect(body.data).toMatchObject({ created: 1, skipped: 1 });
      const record = JSON.parse((await stored(DOMAIN, '/same')) ?? '{}') as KVRouteConfig;
      expect(record.target).toBe('https://dest.example.net/first');
    },
  );
});
