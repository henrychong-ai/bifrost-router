/**
 * Client-side QR download helpers (v1.54.0).
 *
 * SVG downloads serialise the shared renderer's output directly; PNG rasterises
 * it through a canvas. Canvas is browser-only, so this module has no unit tests
 * (jsdom ships no canvas implementation) — it is exercised by the dev-preview
 * smoke test in the release checklist.
 */

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Encode an SVG string as a data URI usable in <img src> (CSP img-src data: allows it). */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** Download the SVG source as a .svg file. */
export function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename.endsWith('.svg') ? filename : `${filename}.svg`);
  URL.revokeObjectURL(url);
}

/**
 * Pre-rasterise any nested SVG-type logo `<image>` inside the QR SVG to a PNG
 * data URI (v1.58.0). Safari and Firefox do not reliably rasterise a nested
 * `data:image/svg+xml` `<image>` through canvas — the PNG export silently
 * dropped SVG logos on those browsers. Substituting a pre-rasterised PNG data
 * URI (drawn on its own offscreen canvas at 2× for crispness) makes the full
 * SVG→canvas pass reliable everywhere, while STORED logos stay vector (the
 * .svg download and Worker render are untouched).
 *
 * Exported for the cross-browser check script (jsdom has no canvas, so this
 * is exercised by scripts/qr-png-export-check.mjs — its in-page copy of this
 * pre-pass logic must be kept in sync with any change here).
 */
export async function rasteriseNestedSvgLogos(svg: string): Promise<string> {
  const nested = [...svg.matchAll(/<image href="(data:image\/svg\+xml[^"]*)"/g)];
  let result = svg;
  for (const match of nested) {
    const svgUri = match[1];
    const img = new Image();
    img.src = svgUri;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Nested SVG logo failed to decode'));
    });
    // Clamp the offscreen canvas: SVG intrinsic dimensions are declared by the
    // (byte-limited but dimension-unbounded) logo file — a crafted
    // width="20000" must not allocate a huge canvas. 1024px per edge is ample
    // for a centre-logo rasterisation at any supported QR size.
    const scale = Math.min(1, 512 / Math.max(img.naturalWidth || 256, img.naturalHeight || 256));
    const w = Math.min(1024, Math.max(1, Math.round((img.naturalWidth || 256) * 2 * scale)));
    const h = Math.min(1024, Math.max(1, Math.round((img.naturalHeight || 256) * 2 * scale)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    result = result.replace(svgUri, canvas.toDataURL('image/png'));
  }
  return result;
}

/**
 * Rasterise the SVG to PNG at the given pixel size and download it.
 * PNG is the format email clients and slide tools handle reliably.
 *
 * SVG-type logos are pre-rasterised first (see above); if that pre-pass fails
 * the export proceeds with the original markup — Chromium still renders it,
 * Safari/Firefox may omit the logo — and the caller is told via the thrown-less
 * `onLogoFallback` hook so it can toast a fidelity warning.
 */
export async function downloadPng(
  svg: string,
  size: number,
  filename: string,
  onLogoFallback?: () => void,
): Promise<void> {
  let prepared = svg;
  try {
    prepared = await rasteriseNestedSvgLogos(svg);
  } catch {
    onLogoFallback?.();
  }
  const img = new Image();
  img.src = svgToDataUri(prepared);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load SVG for rasterisation'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, size, size);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename.endsWith('.png') ? filename : `${filename}.png`);
  URL.revokeObjectURL(url);
}
