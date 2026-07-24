import { describe, it, expect } from 'vitest';
import { QRDesignSchema } from './qr.js';
import { renderQrSvg, qrContrastRatio } from './qr-render.js';

const PNG_LOGO = `data:image/png;base64,${Buffer.from('logo-bytes').toString('base64')}`;

/** Extract the QR module `<path>` data (ignores the injected logo markup). */
function pathData(svg: string): string {
  return svg.match(/<path[^>]*d="([^"]*)"/)?.[1] ?? '';
}

describe('renderQrSvg', () => {
  it('renders an SVG sized to the design with fg/bg colors applied', () => {
    const svg = renderQrSvg('https://links.example.com/x', QRDesignSchema.parse({}));
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="512" height="512"');
    expect(svg).toContain('fill:#ffffff');
    expect(svg).toContain('fill:#000000');
    expect(svg).toContain('</svg>');
  });

  it('honours custom size and colors', () => {
    const svg = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ size: 256, fg: '#112233', bg: '#eeeeee' }),
    );
    expect(svg).toContain('width="256" height="256"');
    expect(svg).toContain('fill:#112233');
    expect(svg).toContain('fill:#eeeeee');
  });

  it('varies output with margin (quiet-zone modules)', () => {
    const tight = renderQrSvg('hello', QRDesignSchema.parse({ margin: 0 }));
    const roomy = renderQrSvg('hello', QRDesignSchema.parse({ margin: 8 }));
    expect(pathData(tight)).not.toBe(pathData(roomy));
  });

  it('injects a centered bg rect + <image> at 22% of size when a logo is present', () => {
    const svg = renderQrSvg('hello', QRDesignSchema.parse({ logoDataUri: PNG_LOGO }));
    // 512 * 0.22 = 112.64, centered at (512 - 112.64) / 2 = 199.68
    expect(svg).toContain(
      `<rect x="199.68" y="199.68" width="112.64" height="112.64" fill="#ffffff"/>`,
    );
    expect(svg).toContain(
      `<image href="${PNG_LOGO}" x="199.68" y="199.68" width="112.64" height="112.64"/>`,
    );
    // Injected before the closing tag.
    expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('</svg>'));
  });

  it('forces error correction to H when a logo is present', () => {
    const withLogo = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ errorCorrection: 'L', logoDataUri: PNG_LOGO }),
    );
    const explicitH = renderQrSvg('hello', QRDesignSchema.parse({ errorCorrection: 'H' }));
    const explicitL = renderQrSvg('hello', QRDesignSchema.parse({ errorCorrection: 'L' }));
    // Module path with the logo matches an explicit-H render, not the requested L.
    expect(pathData(withLogo)).toBe(pathData(explicitH));
    expect(pathData(withLogo)).not.toBe(pathData(explicitL));
  });

  it('omits logo markup when no logo is set', () => {
    const svg = renderQrSvg('hello', QRDesignSchema.parse({}));
    expect(svg).not.toContain('<image');
  });

  // v1.58.0 — wide-logo mode (wordmark-style logos, e.g. a 5.3:1 lockup).

  it('uses a WIDE window when logoAspectRatio > 2 (width 50%, height derived)', () => {
    const svg = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ logoDataUri: PNG_LOGO, logoAspectRatio: 900 / 170 }),
    );
    // width = 512 * 0.5 = 256; height = 256 / (900/170) = 48.355…; centered.
    const logoW = 256;
    const logoH = 256 / (900 / 170);
    const xOff = (512 - logoW) / 2;
    const yOff = (512 - logoH) / 2;
    expect(svg).toContain(
      `<rect x="${xOff}" y="${yOff}" width="${logoW}" height="${logoH}" fill="#ffffff"/>`,
    );
    expect(svg).toContain(`<image href="${PNG_LOGO}" x="${xOff}" y="${yOff}"`);
  });

  it('classifies a 900×364 lockup as wide, above the square footprint', () => {
    // A 2.47:1 lockup sits
    // between a 5.3:1 wordmark and the >2 threshold, and it lands
    // BELOW the height cap, so the window is the widest this mode produces:
    // 50% × 20.22% = 10.11% of area, over twice the square window's 4.84%.
    // Still well inside forced EC-H's ~30% budget, but the "wide obscures
    // fewer modules" shorthand does NOT hold at this ratio.
    const svg = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ logoDataUri: PNG_LOGO, logoAspectRatio: 900 / 364 }),
    );
    const logoW = 512 * 0.5;
    const logoH = logoW / (900 / 364);
    expect(logoH).toBeLessThan(512 * 0.22); // below the cap → not clamped
    expect(svg).toContain(`width="${logoW}" height="${logoH}"`);
    expect((logoW * logoH) / (512 * 512)).toBeCloseTo(0.1011, 4);
    expect((logoW * logoH) / (512 * 512)).toBeGreaterThan(0.22 * 0.22);
  });

  it('caps the wide window height at the square height for mild ratios (e.g. 2.1)', () => {
    const svg = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ logoDataUri: PNG_LOGO, logoAspectRatio: 2.1 }),
    );
    // Uncapped height would be 256/2.1 = 121.9 > 512*0.22 = 112.64 → capped.
    expect(svg).toContain(`height="${512 * 0.22}"`);
    expect(svg).toContain(`width="256"`);
  });

  it('keeps the square window at ratio <= 2 and when no ratio is stored (back-compat lock)', () => {
    const withMildRatio = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ logoDataUri: PNG_LOGO, logoAspectRatio: 1.5 }),
    );
    const withoutRatio = renderQrSvg('hello', QRDesignSchema.parse({ logoDataUri: PNG_LOGO }));
    for (const svg of [withMildRatio, withoutRatio]) {
      expect(svg).toContain(
        `<rect x="199.68" y="199.68" width="112.64" height="112.64" fill="#ffffff"/>`,
      );
    }
    // Byte-identical to the pre-v1.58 square output when no ratio is stored.
    expect(withoutRatio).toBe(withMildRatio);
  });

  it('paints the logo knockout window in the design bg, not hardcoded white (v1.58.2)', () => {
    // Brand presets ship tinted backgrounds since v1.58.2 — a knockout window
    // left at #ffffff would punch a white hole through the tint.
    const svg = renderQrSvg(
      'hello',
      QRDesignSchema.parse({ fg: '#252F49', bg: '#E7D7B9', logoDataUri: PNG_LOGO }),
    );
    expect(svg).toContain(
      `<rect x="199.68" y="199.68" width="112.64" height="112.64" fill="#E7D7B9"/>`,
    );
    expect(svg).not.toContain('#ffffff');
  });
});

describe('qrContrastRatio', () => {
  it('returns 21 for black on white', () => {
    expect(qrContrastRatio('#000000', '#ffffff')).toBe(21);
  });

  it('returns 1 for identical colors', () => {
    expect(qrContrastRatio('#123456', '#123456')).toBe(1);
  });

  it('returns ~4.0 for red on white (below the 4.5 warning threshold)', () => {
    expect(qrContrastRatio('#ff0000', '#ffffff')).toBeCloseTo(4.0, 1);
    expect(qrContrastRatio('#ff0000', '#ffffff')).toBeLessThan(4.5);
  });

  it('is symmetric in its arguments', () => {
    expect(qrContrastRatio('#ffffff', '#ff0000')).toBe(qrContrastRatio('#ff0000', '#ffffff'));
  });
});
