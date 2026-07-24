/**
 * Shared QR renderer (v1.54.0) — ONE renderer, three consumers: the Worker
 * (`GET /api/qr/:id/image`), the MCP tools (base64 SVG), and the admin
 * dashboard (live preview + downloads). Pure string-in/string-out over the
 * `qrcode-svg` package — no DOM, no Canvas, no fs — so output is byte-identical
 * in the Worker and the browser bundle (WYSIWYG by construction).
 */

import QRCode from 'qrcode-svg';
import type { QRDesign } from './qr.js';

/**
 * Logo edge length as a fraction of the rendered size (square window).
 *
 * These three are EXPORTED (v1.58.4) because the embed pipeline must size its
 * raster to the window this renderer will draw it into. Keeping them private
 * is what let the two drift: the embed capped every logo at 128px while a wide
 * window is 50% of the QR (512px at the largest offered size), so wide logos
 * were upscaled up to 4× and rendered visibly blurry.
 */
export const LOGO_SIZE_RATIO = 0.22;

/**
 * Wide-logo mode (v1.58.0): aspect ratios above this use a WIDE centre window
 * instead of the square one, so wordmark-style logos stay legible.
 */
export const WIDE_LOGO_MIN_RATIO = 2;

/** Wide window width as a fraction of the rendered size. */
export const WIDE_LOGO_WIDTH_RATIO = 0.5;

/**
 * Render the serialized QR content to an SVG string. When a logo is present,
 * error correction is FORCED to 'H' (the logo obscures the center modules) and
 * a centered background rect + `<image>` are injected before `</svg>`.
 *
 * Window geometry: square at 22% of size by default; when `logoAspectRatio`
 * exceeds {@link WIDE_LOGO_MIN_RATIO} the window is WIDE — 50% of size across,
 * height derived from the ratio (capped at the square height). Occlusion
 * budget: square = 4.84% of area; wide = 50% × min(50%/ratio, 22%) — up to 11%
 * at the height cap (ratios 2–5.17), falling below the square's footprint past
 * ~5.17 (e.g. a 5.3:1 wordmark ≈ 4.7%). All well inside the forced 'H'
 * correction's 30% redundancy. Records without a stored ratio render
 * byte-identically to pre-v1.58 output.
 */
export function renderQrSvg(content: string, design: QRDesign): string {
  const svg = new QRCode({
    content,
    padding: design.margin,
    width: design.size,
    height: design.size,
    color: design.fg,
    background: design.bg,
    ecl: design.logoDataUri ? 'H' : design.errorCorrection,
    join: true,
  }).svg();

  if (!design.logoDataUri) return svg;

  const wide = design.logoAspectRatio !== undefined && design.logoAspectRatio > WIDE_LOGO_MIN_RATIO;
  const logoW = wide ? design.size * WIDE_LOGO_WIDTH_RATIO : design.size * LOGO_SIZE_RATIO;
  const logoH = wide
    ? Math.min(logoW / (design.logoAspectRatio as number), design.size * LOGO_SIZE_RATIO)
    : logoW;
  const xOff = (design.size - logoW) / 2;
  const yOff = (design.size - logoH) / 2;
  const logo =
    `<rect x="${xOff}" y="${yOff}" width="${logoW}" height="${logoH}" fill="${design.bg}"/>` +
    `<image href="${design.logoDataUri}" x="${xOff}" y="${yOff}" width="${logoW}" height="${logoH}"/>`;
  return svg.replace('</svg>', `${logo}</svg>`);
}

/**
 * WCAG 2.x contrast ratio between two `#rrggbb` colors (1..21). Pure helper
 * for the dashboard's unscannable-color warning (flag below 4.5:1).
 */
export function qrContrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG relative luminance of a `#rrggbb` color (0..1). */
function relativeLuminance(hex: string): number {
  const r = linearChannel(Number.parseInt(hex.slice(1, 3), 16));
  const g = linearChannel(Number.parseInt(hex.slice(3, 5), 16));
  const b = linearChannel(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** sRGB 8-bit channel → linear-light value. */
function linearChannel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}
