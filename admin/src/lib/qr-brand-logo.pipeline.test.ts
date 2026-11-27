// @vitest-environment happy-dom

import { QR_LOGO_MAX_BYTES } from '@bifrost/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as QrBrandLogoModule from './qr-brand-logo';

const download = vi.hoisted(() => vi.fn<(bucket: string, key: string) => Promise<Blob>>());
vi.mock('@/lib/api-client', () => ({ storageApi: { downloadObject: download } }));
let logo: typeof QrBrandLogoModule;
let width: number;
let height: number;
let failDecode: boolean;
let draw: ReturnType<typeof vi.fn<(...args: number[]) => void>>;
beforeEach(async () => {
  vi.resetModules();
  logo = await import('./qr-brand-logo');
  width = 1000;
  height = 250;
  failDecode = false;
  draw = vi.fn<(...args: number[]) => void>();
  download.mockReset().mockResolvedValue(new Blob(['asset']));
  vi.stubGlobal(
    'Image',
    class extends EventTarget {
      naturalWidth = width;
      naturalHeight = height;
      set src(_value: string) {
        queueMicrotask(() => this.dispatchEvent(new Event(failDecode ? 'error' : 'load')));
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG5n');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logo');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('brand logo fetch and raster pipeline', () => {
  it('loads from the authenticated assets API, deduplicates concurrent work, and memoises results', async () => {
    const first = logo.fetchBrandLogo('brand/logo.svg');
    const second = logo.fetchBrandLogo('brand/logo.svg');
    expect(second).toBe(first);
    expect(await first).toEqual({ dataUri: 'data:image/png;base64,cG5n', aspectRatio: 4 });
    expect(await logo.fetchBrandLogo('brand/logo.svg')).toEqual(await first);
    expect(download).toHaveBeenCalledExactlyOnceWith('assets', 'brand/logo.svg');
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 128);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:logo');
  });
  it('does not share cache entries across asset keys', async () => {
    await logo.fetchBrandLogo('one.svg');
    await logo.fetchBrandLogo('two.svg');
    expect(download).toHaveBeenCalledTimes(2);
  });
  it('does not upscale a small source', async () => {
    width = 20;
    height = 10;
    await logo.fetchBrandLogo('small');
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 20, 10);
  });
  it('retries a failed fetch on the next attempt', async () => {
    download.mockRejectedValueOnce(new Error('offline'));
    await expect(logo.fetchBrandLogo('retry')).rejects.toThrow('offline');
    await expect(logo.fetchBrandLogo('retry')).resolves.toHaveProperty('dataUri');
    expect(download).toHaveBeenCalledTimes(2);
  });
  it('fails a stalled download after the timeout and downloads again next time (v1.47.0)', async () => {
    vi.useFakeTimers();
    try {
      download.mockReturnValueOnce(new Promise(() => undefined));
      const stalled = logo.fetchBrandLogo('stalled');
      const outcome = stalled.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
      );
      await vi.advanceTimersByTimeAsync(logo.LOGO_FETCH_TIMEOUT_MS - 1);
      expect(logo.fetchBrandLogo('stalled')).toBe(stalled);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe('Logo download timed out');
    } finally {
      vi.useRealTimers();
    }
    // The timed-out promise is not cached: the next attempt downloads again
    await expect(logo.fetchBrandLogo('stalled')).resolves.toHaveProperty('dataUri');
    expect(download).toHaveBeenCalledTimes(2);
  });
  it('releases the object URL after decode failure and allows retry', async () => {
    failDecode = true;
    await expect(logo.fetchBrandLogo('bad')).rejects.toThrow('Logo image failed to decode');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:logo');
    failDecode = false;
    await expect(logo.fetchBrandLogo('bad')).resolves.toHaveProperty('dataUri');
    expect(download).toHaveBeenCalledTimes(2);
  });
  it('releases the object URL when canvas is unavailable', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(logo.fetchBrandLogo('canvas')).rejects.toThrow('Canvas 2D context unavailable');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:logo');
  });
  it('steps down resolution only when encoded bytes exceed the cap', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValueOnce(
      'data:image/png;base64,' + 'A'.repeat(Math.ceil((QR_LOGO_MAX_BYTES + 3) / 3) * 4),
    );
    await logo.fetchBrandLogo('detailed');
    expect(draw.mock.calls.map(args => args.slice(3))).toEqual([
      [512, 128],
      [384, 96],
    ]);
  });
  it('returns the smallest encoding for schema rejection when all candidates exceed the cap', async () => {
    const oversized =
      'data:image/png;base64,' + 'A'.repeat(Math.ceil((QR_LOGO_MAX_BYTES + 3) / 3) * 4);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(oversized);
    expect((await logo.fetchBrandLogo('huge')).dataUri).toBe(oversized);
    expect(draw.mock.calls.map(args => args[3])).toEqual([512, 384, 256, 192, 128]);
  });
  it.each([
    [100, 50, 2],
    [20000, 1, 12],
    [1, 20000, 0.2],
    [0, 100, null],
    [100, 0, null],
  ])('computes a schema-safe ratio for %s×%s', async (w, h, expected) => {
    width = w!;
    height = h!;
    expect(await logo.computeLogoAspectRatio('data:image/png;base64,cG5n')).toBe(expected);
  });
  it('returns null for an undecodable uploaded image', async () => {
    failDecode = true;
    expect(await logo.computeLogoAspectRatio('bad')).toBeNull();
  });
});
