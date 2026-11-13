/**
 * Decoder check for the logo windows. The renderer's occlusion budget (the
 * square window 4.84% of the rendered area; the wide window up to 11% just
 * above the wide threshold, shrinking as the ratio grows) is documented in
 * `qr-render.ts`. This test proves it with a decoder: it rasterises the shared
 * renderer's own SVG (sharp, through librsvg) and decodes it with jsQR, which
 * knows nothing about the logo, across payload densities, logo shapes, sizes
 * and both logo shades.
 *
 * The logo is a fully opaque block, the worst case: every module under the
 * window is lost, either all dark (a logo in the module colour) or all light
 * (a logo in the background colour, the same as the bare plate). The default
 * 4-module margin is used throughout.
 */

import jsQR from 'jsqr';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { QRDesignSchema } from './qr.js';
import { renderQrSvg, WIDE_LOGO_MIN_RATIO } from './qr-render.js';

/** A fully opaque solid PNG of the given shape, as a data URI. */
async function solidLogo(width: number, height: number, colour: string): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 4, background: colour },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Rasterise an SVG and decode it; null when no code is found. */
async function decode(svg: string): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return found ? found.data : null;
}

/** The fraction of the rendered area the logo plate covers. */
function plateShare(svg: string, size: number): number {
  // The plate is the rect drawn straight before the logo <image>
  const plate = svg.match(
    /<rect x="[^"]*" y="[^"]*" width="([^"]*)" height="([^"]*)"[^>]*\/><image /,
  );
  if (!plate) return 0;
  return (Number(plate[1]) * Number(plate[2])) / (size * size);
}

/** Render `content` with a solid logo of `ratio` (1 = no stored ratio, the square window). */
async function renderWithLogo(
  content: string,
  ratio: number,
  size: number,
  colour: string,
): Promise<string> {
  const logoHeight = 64;
  const logoDataUri = await solidLogo(Math.round(logoHeight * ratio), logoHeight, colour);
  return renderQrSvg(
    content,
    QRDesignSchema.parse({
      size,
      logoDataUri,
      ...(ratio === 1 ? {} : { logoAspectRatio: ratio }),
    }),
  );
}

// Representative payloads, from a short link to a dense contact-card-sized text
const PAYLOADS = {
  'short link': 'https://links.example.com/abcdef',
  'tracked link': `https://links.example.com/campaign/2026-q4?utm_source=print&utm_medium=card&utm_campaign=${'a'.repeat(40)}`,
  'dense text': `BEGIN:VCARD\nVERSION:3.0\nN:Example;Person;;;\nFN:Person Example\nORG:Example Holdings\nTITLE:Director\nTEL;TYPE=WORK,VOICE:+1 555 0100\nEMAIL;TYPE=INTERNET:person@example.com\nURL:https://www.example.com/${'p'.repeat(120)}\nEND:VCARD`,
} as const;

// Logo shapes (width:height). 1 = the square window; above WIDE_LOGO_MIN_RATIO
// the wide window. 2.01 gives the largest wide plate (11%), 5.17 is where the
// wide window's height cap ends, 12 the widest ratio the schema accepts.
const RATIOS = [1, 2.01, 2.49, 3.5, 5.17, 5.3, 12] as const;

const SIZES = [512, 1024] as const;

const SHADES = [
  ['dark', '#000000'],
  ['light', '#ffffff'],
] as const;

describe('rendered QR codes with a logo still scan (decoder check)', () => {
  it('uses the wide window for every ratio above the threshold in this matrix', () => {
    expect(RATIOS.filter(ratio => ratio > WIDE_LOGO_MIN_RATIO)).toEqual([
      2.01, 2.49, 3.5, 5.17, 5.3, 12,
    ]);
  });

  for (const [name, content] of Object.entries(PAYLOADS)) {
    for (const ratio of RATIOS) {
      for (const size of SIZES) {
        for (const [shade, colour] of SHADES) {
          it(`${name}, logo ${ratio}:1 (${shade}), ${size}px decodes to the payload`, async () => {
            const svg = await renderWithLogo(content, ratio, size, colour);
            // The plate is really there, inside the documented footprint
            expect(svg).toContain('<image href="data:image/png;base64,');
            expect(plateShare(svg, size)).toBeGreaterThan(0.02);
            expect(plateShare(svg, size)).toBeLessThanOrEqual(0.111);
            expect(await decode(svg)).toBe(content);
          });
        }
      }
    }
  }

  it('fails to decode when the occlusion is far past the budget (the check has teeth)', async () => {
    const content = PAYLOADS['dense text'];
    const svg = renderQrSvg(content, QRDesignSchema.parse({ size: 1024, errorCorrection: 'H' }));
    // Cover the middle 60% x 40% of the code: far beyond what level H restores
    const blocked = svg.replace(
      '</svg>',
      '<rect x="204.8" y="307.2" width="614.4" height="409.6" fill="#000000"/></svg>',
    );
    expect(await decode(svg)).toBe(content);
    expect(await decode(blocked)).toBeNull();
  });
});
