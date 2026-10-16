/**
 * Real UTF-8 in QR content (v1.42.1). qrcode-svg 1.1.0's QR8bitByte encoded
 * each UTF-16 unit on its own: an emoji became six CESU-8 bytes
 * (ED A0 BD ED B8 80) instead of F0 9F 98 80, U+0080 and U+0800 fell into the
 * wrong branch (`>` for `>=`), the symbol was sized from an encodeURI length
 * that differed from the bytes written (a short emoji card threw `code length
 * overflow`, a 500 from the image route), and a lone surrogate made encodeURI
 * throw URIError on every render. The dependency is patched
 * (patches/qrcode-svg-1.1.0.patch) to encode with TextEncoder and to size the
 * symbol from those bytes.
 */
import QRCode from 'qrcode-svg';
import { describe, expect, it } from 'vitest';
import { QRDesignSchema, serializeVcard } from './qr.js';
import { renderQrSvg } from './qr-render.js';

interface Segment {
  getLength(): number;
  write(buffer: { put(num: number, length: number): void }): void;
}

/** The symbol the library builds for `content`. */
function symbol(content: string, ecl: 'L' | 'M' | 'Q' | 'H' = 'M') {
  return (
    new QRCode({ content, ecl }) as unknown as {
      qrcode: { typeNumber: number; dataList: Segment[] };
    }
  ).qrcode;
}

const utf8 = (content: string) => [...new TextEncoder().encode(content)];

/** The bytes the library writes into the symbol for `content`, captured from `write`. */
function writtenBytes(content: string): number[] {
  const bytes: number[] = [];
  for (const segment of symbol(content).dataList) {
    segment.write({
      put(num, length) {
        expect(length).toBe(8);
        bytes.push(num);
      },
    });
    expect(segment.getLength()).toBe(utf8(content).length);
  }
  return bytes;
}

/** Byte-mode capacity at EC M of versions 1 to 12 (the library's QRCodeLimitLength). */
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287];

/**
 * The version the patched library picks: the smallest whose capacity holds
 * the UTF-8 byte count plus the library's own 3-byte allowance (kept so ASCII
 * sizes, and so renders, exactly as before).
 */
const expectedVersion = (content: string) =>
  CAPACITY_M.findIndex(capacity => utf8(content).length + 3 <= capacity) + 1;

describe('QR content is real UTF-8 (v1.42.1)', () => {
  it('an emoji text code writes the emoji as its four UTF-8 bytes', () => {
    expect(writtenBytes('Hi 😀')).toEqual([0x48, 0x69, 0x20, 0xf0, 0x9f, 0x98, 0x80]);
  });

  it('an emoji contact card writes exactly its UTF-8 bytes', () => {
    const card = serializeVcard({ firstName: 'Jane 🌸', surname: 'Doe', title: '🚀 Lead' });
    const bytes = writtenBytes(card);
    expect(bytes).toEqual(utf8(card));
    expect(String.fromCharCode(...bytes.slice(0, 11))).toBe('BEGIN:VCARD');
    // No CESU-8 surrogate bytes (ED A0..BF ..) anywhere
    expect(bytes.some((byte, i) => byte === 0xed && (bytes[i + 1] ?? 0) >= 0xa0)).toBe(false);
  });

  it.each([
    ['U+007F', '\u007f', [0x7f]],
    ['U+0080', '\u0080', [0xc2, 0x80]],
    ['U+07FF', '߿', [0xdf, 0xbf]],
    ['U+0800', 'ࠀ', [0xe0, 0xa0, 0x80]],
    ['U+FFFF', '￿', [0xef, 0xbf, 0xbf]],
    ['U+10000', '\u{10000}', [0xf0, 0x90, 0x80, 0x80]],
    ['U+10FFFF', '\u{10ffff}', [0xf4, 0x8f, 0xbf, 0xbf]],
  ])('%s encodes as its UTF-8 bytes', (_label, character, expected) => {
    expect(writtenBytes(`a${character}b`)).toEqual([0x61, ...expected, 0x62]);
  });

  it('five emoji fit version 2 at EC M (the old encoder wrote 30 bytes into 26 and threw)', () => {
    const content = '😀'.repeat(5);
    expect(() => symbol(content)).not.toThrow();
    expect(symbol(content).typeNumber).toBe(2);
    expect(utf8(content)).toHaveLength(20);
  });

  it('an emoji card that fills a version at EC M renders there, sized from its real byte count', () => {
    const base = { firstName: 'Jane 🌸', surname: 'Doe', title: '🚀 Lead', org: '' };
    const card = (org: string) => serializeVcard({ ...base, org });
    const capacity = CAPACITY_M[9] ?? 0;
    // Pad the org until the card plus the allowance exactly fills version 10 (213 bytes)
    const pad = capacity - 3 - utf8(card('X')).length + 1;
    const full = card('X'.repeat(pad));
    expect(utf8(full).length + 3).toBe(capacity);
    const design = QRDesignSchema.parse({ errorCorrection: 'M' });
    expect(() => renderQrSvg(full, design)).not.toThrow();
    expect(symbol(full).typeNumber).toBe(10);
    expect(writtenBytes(full)).toEqual(utf8(full));
    // One byte more moves to version 11
    const over = card('X'.repeat(pad + 1));
    expect(symbol(over).typeNumber).toBe(11);
    expect(() => renderQrSvg(over, design)).not.toThrow();
  });

  it.each([
    ['an emoji text', 'Hi 😀 there 🎉'],
    ['an emoji card', serializeVcard({ firstName: '🌸', org: 'Example 🚀' })],
    ['CJK text', '会议室 3 — 欢迎'],
    ['ASCII', 'https://links.example.com/x'],
  ])('%s is sized from its UTF-8 byte count', (_label, content) => {
    expect(symbol(content).typeNumber).toBe(expectedVersion(content));
  });

  it('a stored lone surrogate renders as U+FFFD and never throws', () => {
    const design = QRDesignSchema.parse({});
    for (const lone of ['\ud83d', '\ude00', '\ude00\ud83d']) {
      const content = `A${lone}B`;
      expect(() => renderQrSvg(content, design)).not.toThrow();
      expect(renderQrSvg(content, design)).toBe(
        renderQrSvg(`A${'�'.repeat(lone.length)}B`, design),
      );
    }
    expect(writtenBytes('A\ud83dB')).toEqual([0x41, 0xef, 0xbf, 0xbd, 0x42]);
  });
});
