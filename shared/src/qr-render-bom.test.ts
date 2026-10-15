/**
 * No UTF-8 byte-order mark in QR content (v1.42.0). qrcode-svg 1.1.0
 * prepended EF BB BF to the encoded bytes whenever the content held a
 * non-ASCII character, so a contact card with an accented name encoded
 * BOM + "BEGIN:VCARD", which scanners that need BEGIN:VCARD at offset 0 (such
 * as ZXing's vCard parser) may show as plain text. The dependency is patched
 * (patches/qrcode-svg-1.1.0.patch) to encode plain UTF-8.
 */
import { createHash } from 'node:crypto';
import QRCode from 'qrcode-svg';
import { describe, expect, it } from 'vitest';
import { isRecord } from './guards.js';
import { QRDesignSchema, serializeVcard } from './qr.js';
import { renderQrSvg } from './qr-render.js';

/** The library's own encoded byte segments for `content` (its QR8bitByte data). */
function encodedBytes(content: string): number[] {
  const code: unknown = new QRCode({ content });
  const inner = isRecord(code) ? code['qrcode'] : undefined;
  const segments = isRecord(inner) ? inner['dataList'] : undefined;
  if (!Array.isArray(segments)) throw new Error('qrcode-svg internals changed');
  return segments.flatMap((segment: unknown) => {
    const data = isRecord(segment) ? segment['parsedData'] : undefined;
    if (!Array.isArray(data) || !data.every(byte => typeof byte === 'number')) {
      throw new Error('qrcode-svg internals changed');
    }
    return data;
  });
}

const utf8 = (content: string) => [...new TextEncoder().encode(content)];

const BOM = [0xef, 0xbb, 0xbf];

/** A full ASCII contact card (the golden card in qr.test.ts). */
const ASCII_CARD = {
  firstName: 'Jane',
  surname: 'Doe',
  org: 'Example Widgets, Inc.',
  title: 'Head of Operations; Asia',
  phones: [
    { number: '+1 555 0100', type: 'work' as const },
    { number: '+1 555 0199', type: 'main' as const },
  ],
  email: 'jane.doe@example.com',
  url: 'example.com',
  address: {
    street: 'Suite 12, 100 Main Street',
    city: 'Springfield',
    region: 'Example State',
    postcode: '12345',
    country: 'Exampleland',
  },
};

describe('QR content is plain UTF-8 with no byte-order mark (v1.42.0)', () => {
  it.each([
    ['an accented vCard', serializeVcard({ firstName: 'José', surname: 'Müller-Ñúñez' })],
    ['CJK text', '会议室 3 — 欢迎'],
    ['a non-ASCII Wi-Fi network', 'WIFI:T:WPA;S:Café;P:pässwörd;;'],
  ])('%s encodes exactly its UTF-8 bytes, with no EF BB BF in front', (_label, content) => {
    const bytes = encodedBytes(content);
    expect(bytes.slice(0, 3)).not.toEqual(BOM);
    expect(bytes).toEqual(utf8(content));
  });

  it('an accented vCard starts with BEGIN:VCARD at byte 0', () => {
    const bytes = encodedBytes(serializeVcard({ firstName: 'José', surname: 'Doe' }));
    expect(String.fromCharCode(...bytes.slice(0, 11))).toBe('BEGIN:VCARD');
  });

  it('ASCII content encodes its bytes as before (no BOM was ever added to it)', () => {
    for (const content of ['https://links.example.com/x', serializeVcard(ASCII_CARD)]) {
      expect(encodedBytes(content)).toEqual(utf8(content));
    }
  });

  // The SHA-256 of each SVG as the UNPATCHED qrcode-svg 1.1.0 rendered it
  // (default design), recorded before the patch: ASCII content renders byte
  // for byte as before.
  it.each([
    [
      'a URL short link',
      'https://links.example.com/x',
      '2544c6c7b8f3baa4c4a38dc2cebd38066ea5444db4ef6a4bf8763b78c83004e9',
    ],
    [
      'an ASCII vCard',
      serializeVcard(ASCII_CARD),
      '3e30286c68608891ceede8b15e0cb3a9fd5687b202bcdea86c292d696a039b2e',
    ],
  ])('%s renders byte-identically to the unpatched library', (_label, content, sha256) => {
    const svg = renderQrSvg(content, QRDesignSchema.parse({}));
    expect(createHash('sha256').update(svg).digest('hex')).toBe(sha256);
  });
});
