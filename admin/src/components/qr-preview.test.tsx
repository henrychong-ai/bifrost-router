import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QrPreview } from './qr-preview';

const design = {
  fg: '#000000',
  bg: '#ffffff',
  size: 256,
  margin: 4,
  errorCorrection: 'H',
} as const;

describe('QrPreview', () => {
  it('renders the code as an image', () => {
    const html = renderToStaticMarkup(<QrPreview content="https://example.com/" design={design} />);
    expect(html).toContain('alt="QR code preview"');
    expect(html).toContain('width="192"');
  });

  it('keeps an image of the same size, named for what happened, when the code cannot render', () => {
    // Past the largest QR version's capacity at the highest error correction.
    const html = renderToStaticMarkup(<QrPreview content={'x'.repeat(5000)} design={design} />);
    expect(html).toMatch(/^<img /);
    expect(html).toContain('alt="QR preview unavailable"');
    expect(html).toContain('width="192"');
    expect(html).toContain('height="192"');
    expect(html).not.toContain('role=');
  });
});
