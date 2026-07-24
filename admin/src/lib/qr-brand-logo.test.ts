import { describe, expect, it, vi } from 'vitest';
import { LOGO_SIZE_RATIO, WIDE_LOGO_MIN_RATIO, WIDE_LOGO_WIDTH_RATIO } from '@bifrost/shared';

// qr-brand-logo.ts transitively imports @/lib/api-client → @/env, whose
// window.__ENV__ read explodes in the node test environment. The functions
// under test here are pure — mock the client module away.
vi.mock('@/lib/api-client', () => ({ storageApi: { downloadObject: vi.fn() } }));

import { MAX_QR_SIZE, targetEmbedDim } from './qr-brand-logo';

/**
 * Embed-resolution guard (v1.58.4). The defect this locks down: the embed
 * pipeline capped every logo at 128px while the renderer's WIDE window is 50%
 * of the QR — 512px at the largest offered size — so wide marks (wordmark-style
 * lockups) were upscaled 2–4× and rendered blurry.
 *
 * The window maths is derived from the SHARED renderer constants rather than
 * restated, so changing a ratio there fails here instead of silently
 * reintroducing the mismatch.
 */
function windowPxAt(aspectRatio: number, size: number): number {
  return aspectRatio > WIDE_LOGO_MIN_RATIO ? size * WIDE_LOGO_WIDTH_RATIO : size * LOGO_SIZE_RATIO;
}

describe('targetEmbedDim', () => {
  it('never embeds below the window the renderer draws into (the blur bug)', () => {
    // Spans both sides of the wide threshold, incl. the two live wide assets.
    const ratios = [0.5, 0.95, 1, 1.07, 1.99, 2, 2.01, 900 / 364, 900 / 170, 12];
    for (const ratio of ratios) {
      expect(targetEmbedDim(ratio)).toBeGreaterThanOrEqual(windowPxAt(ratio, MAX_QR_SIZE));
    }
  });

  it('gives the live wide marks a 512px raster and square marks 256px', () => {
    expect(targetEmbedDim(900 / 364)).toBe(512); // wide lockup, 2.47:1
    expect(targetEmbedDim(900 / 170)).toBe(512); // wordmark, 5.29:1
    expect(targetEmbedDim(1)).toBe(256); // icon-512 square marks
    expect(targetEmbedDim(1.07)).toBe(256); // near-square crest, 900×838
  });

  it('switches window class exactly at the renderer threshold, not near it', () => {
    // > is the renderer's comparison, so the threshold value itself is SQUARE.
    expect(targetEmbedDim(WIDE_LOGO_MIN_RATIO)).toBe(256);
    expect(targetEmbedDim(WIDE_LOGO_MIN_RATIO + 0.01)).toBe(512);
  });

  it('does not over-embed a square mark to the wide size (payload restraint)', () => {
    // Every list row carries its logo data URI, so resolution beyond the
    // window is pure page weight.
    expect(targetEmbedDim(1)).toBeLessThan(targetEmbedDim(3));
  });
});
