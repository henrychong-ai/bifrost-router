/**
 * Brand-preset logo pipeline (v1.58.0).
 *
 * Fetches a preset's logo from the `assets` bucket through the SAME-ORIGIN
 * authed storage API (hot-load doctrine: brand assets are never bundled; CSP
 * connect-src needs no R2 origins because the fetch is same-origin), then
 * canvas-downscales it to a compact PNG data URI for embedding in the QR
 * record. Always emits PNG — embedded preset logos are therefore immune to
 * the Safari/Firefox nested-SVG rasterisation gap by construction.
 *
 * Results are memoised per asset key for the session — repeat creates and
 * preset toggling never refetch.
 */

import {
  base64DecodedBytes,
  LOGO_SIZE_RATIO,
  QR_LOGO_MAX_BYTES,
  WIDE_LOGO_MIN_RATIO,
  WIDE_LOGO_WIDTH_RATIO,
} from '@bifrost/shared';
import { storageApi } from '@/lib/api-client';

/**
 * Largest QR size the create dialog offers. The embedded raster must serve
 * this size — anything smaller is upscaled by the renderer and looks blurry.
 */
export const MAX_QR_SIZE = 1024;

/**
 * Candidate longest-edge dimensions, largest first. The chosen target is
 * derived from the render window (below); this ladder then steps DOWN if the
 * encoded PNG would breach {@link QR_LOGO_MAX_BYTES}, so a detailed mark
 * degrades in resolution rather than failing schema validation outright.
 */
const EMBED_STEPS = [512, 384, 256, 192, 128] as const;

/**
 * Longest edge to embed for a logo of this aspect ratio (v1.58.4).
 *
 * Sized to the window the SHARED renderer will draw into at MAX_QR_SIZE — a
 * wide logo occupies 50% of the QR's width, a square one 22%. The previous
 * fixed 128px cap was smaller than every wide window (512px at 1024, 256px at
 * the 512 default), so wide marks — e.g. wordmark lockups around
 * wordmark — were upscaled 2–4× and rendered blurry.
 */
export function targetEmbedDim(aspectRatio: number): number {
  const windowPx =
    aspectRatio > WIDE_LOGO_MIN_RATIO
      ? MAX_QR_SIZE * WIDE_LOGO_WIDTH_RATIO
      : MAX_QR_SIZE * LOGO_SIZE_RATIO;
  // Smallest step that still COVERS the window — never smaller, or the
  // renderer upscales it again. EMBED_STEPS is descending.
  const covering = EMBED_STEPS.filter(d => d >= windowPx);
  return covering.length > 0 ? covering[covering.length - 1] : EMBED_STEPS[0];
}

/**
 * Clamp a computed ratio to the QRDesignSchema range [0.2, 12] — an extreme
 * upload (e.g. a 20:1 banner) degrades to the widest supported window instead
 * of failing schema validation with a cryptic 400.
 */
function clampRatio(ratio: number): number {
  return Math.min(12, Math.max(0.2, ratio));
}

export interface EmbeddedLogo {
  dataUri: string;
  /** Intrinsic w/h of the source image — drives the renderer's wide-logo mode. */
  aspectRatio: number;
}

const cache = new Map<string, Promise<EmbeddedLogo>>();

/** Load a Blob/data-URI into an HTMLImageElement. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Logo image failed to decode'));
    img.src = src;
  });
}

/**
 * Compute the intrinsic aspect ratio (w/h) of an already-embedded logo data
 * URI. Used for USER-uploaded logos so wordmark-shaped uploads also get the
 * wide-logo treatment. Returns null when the image cannot be decoded (the
 * caller simply omits the ratio — renderer falls back to the square window).
 */
export async function computeLogoAspectRatio(dataUri: string): Promise<number | null> {
  try {
    const img = await loadImage(dataUri);
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return clampRatio(img.naturalWidth / img.naturalHeight);
  } catch {
    return null;
  }
}

/** Rasterise `img` to a PNG data URI whose longest edge is `dim` (never upscales). */
function encodeAt(img: HTMLImageElement, dim: number): string {
  const scale = Math.min(1, dim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

/**
 * Encode at the resolution the renderer needs, stepping DOWN only if the
 * byte cap demands it. Measured against the live brand assets: the heaviest
 * (a near-square crest) is 43 KB at its 256px target, and the two wide marks
 * are 26 KB and 19 KB at 512px — all far inside the 100 KB cap, so the ladder
 * is insurance for a future detailed asset rather than a routine path.
 */
async function downscaleToPng(img: HTMLImageElement): Promise<EmbeddedLogo> {
  const ratio = clampRatio(img.naturalWidth / img.naturalHeight);
  const target = targetEmbedDim(ratio);
  let dataUri = '';
  for (const dim of EMBED_STEPS.filter(d => d <= target)) {
    dataUri = encodeAt(img, dim);
    if (base64DecodedBytes(dataUri) <= QR_LOGO_MAX_BYTES) return { dataUri, aspectRatio: ratio };
  }
  // Even the smallest step breached the cap — return it and let the schema
  // surface a precise error rather than silently embedding an oversized logo.
  return { dataUri, aspectRatio: ratio };
}

/**
 * Fetch + downscale a brand logo from the assets bucket. Memoised per key;
 * a failed fetch is NOT cached (next attempt retries).
 */
export function fetchBrandLogo(assetKey: string): Promise<EmbeddedLogo> {
  const cached = cache.get(assetKey);
  if (cached) return cached;
  const pending = (async () => {
    const blob = await storageApi.downloadObject('assets', assetKey);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(objectUrl);
      return await downscaleToPng(img);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  })();
  cache.set(assetKey, pending);
  pending.catch(() => cache.delete(assetKey));
  return pending;
}
