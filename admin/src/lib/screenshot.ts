/**
 * Page screenshot capture (v1.26.0) using modern-screenshot.
 *
 * modern-screenshot serialises the DOM into an SVG <foreignObject> and rasterises
 * it via the real browser, so Tailwind-v4 / oklch colours and self-hosted web
 * fonts render correctly (html2canvas, which re-implements CSS in JS, does not).
 * Best-effort: returns null on any failure (cross-origin images, etc.) — the
 * submission proceeds with a manual-attach fallback.
 */

import { domToBlob } from 'modern-screenshot';

/** Capture the current page as a PNG Blob, or null if capture fails. */
export async function captureScreenshot(): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  try {
    // Cap the raster scale so large/hi-dpi pages don't blow past the 5 MB limit.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    return await domToBlob(document.body, {
      type: 'image/png',
      scale,
      // Skip nodes explicitly marked as private from the shot.
      filter: node => !(node instanceof HTMLElement && node.dataset.feedbackExclude !== undefined),
    });
  } catch {
    return null;
  }
}
