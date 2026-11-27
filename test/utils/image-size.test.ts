/**
 * Reading a preview image's format and pixel size from its bytes (v1.48.0).
 */
import { describe, expect, it } from 'vitest';
import { IMAGE_DIMENSION_MAX, readImage } from '../../src/utils/image-size';
import { jpegBytes, pngBytes } from '../image-bytes';

describe('readImage', () => {
  it('reads a PNG header', () => {
    expect(readImage(pngBytes(1200, 630))).toEqual({
      type: 'image/png',
      width: 1200,
      height: 630,
    });
  });

  it('reads a JPEG frame header after APP segments, fill bytes and a restart marker', () => {
    expect(readImage(jpegBytes(1200, 630))).toEqual({
      type: 'image/jpeg',
      width: 1200,
      height: 630,
    });
    expect(readImage(jpegBytes(640, 480, { progressive: true, fill: true, rst: true }))).toEqual({
      type: 'image/jpeg',
      width: 640,
      height: 480,
    });
  });

  it.each([
    ['empty', new Uint8Array()],
    ['text', new TextEncoder().encode('not an image at all')],
    ['a GIF', new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000')],
    ['a truncated PNG', pngBytes(10, 10).slice(0, 20)],
    [
      'a PNG without IHDR first',
      (() => {
        const bytes = pngBytes(10, 10);
        bytes[12] = 0x58;
        return bytes;
      })(),
    ],
    ['a zero-width PNG', pngBytes(0, 10)],
    [
      'a JPEG with scan data before a frame',
      Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0]),
    ],
    ['a JPEG that ends first', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00])],
    [
      'a JPEG with a bad segment length',
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0]),
    ],
    ['a JPEG losing sync', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12, 0x34])],
    ['a JPEG cut inside its frame header', jpegBytes(10, 10).slice(0, 26)],
    ['a JPEG cut after a marker', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ['a JPEG cut after its fill bytes', Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff])],
    ['a zero-height JPEG', jpegBytes(10, 0)],
    [
      'a JPEG with a short frame header',
      Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x05, 8, 0, 1, 0, 1]),
    ],
  ])('refuses %s as not an image', (_label, bytes) => {
    expect(readImage(bytes)).toEqual({ reason: 'not-image' });
  });

  it.each([
    [
      'a PNG with only its IHDR header, no data and CRC',
      pngBytes(10, 10).slice(0, 24),
      'not-image',
    ],
    ['a PNG one byte short of its IHDR CRC', pngBytes(10, 10).slice(0, 32), 'not-image'],
    [
      'a PNG whose IHDR declares another length',
      (() => {
        const bytes = pngBytes(10, 10);
        bytes[11] = 12;
        return bytes;
      })(),
      'not-image',
    ],
    ['a PNG wider than 16384', pngBytes(16_385, 10), 'too-large'],
    ['a PNG with a 2^32 - 1 height', pngBytes(10, 0xffffffff), 'too-large'],
    ['a JPEG taller than 16384', jpegBytes(10, 16_385), 'too-large'],
    [
      'a JPEG whose frame header runs past the bytes read',
      (() => {
        const bytes = jpegBytes(10, 10);
        return bytes.slice(0, bytes.length - 3);
      })(),
      'not-image',
    ],
    [
      'a JPEG with two components',
      (() => {
        const bytes = jpegBytes(10, 10);
        bytes[29] = 2;
        return bytes;
      })(),
      'unsupported-jpeg',
    ],
    [
      'a JPEG whose frame length does not match its components',
      (() => {
        const bytes = jpegBytes(10, 10);
        bytes[23] = 0x12;
        return bytes;
      })(),
      'unsupported-jpeg',
    ],
  ])('refuses %s', (_label, bytes, reason) => {
    expect(readImage(bytes)).toEqual({ reason });
  });

  it('accepts the largest legal size, 16384 on a side, in both formats', () => {
    expect(readImage(pngBytes(16_384, 16_384))).toMatchObject({ width: 16_384 });
    expect(readImage(jpegBytes(16_384, 1))).toMatchObject({ width: 16_384 });
    expect(IMAGE_DIMENSION_MAX).toBe(16_384);
  });

  it('skips DHT, which shares the frame-marker range', () => {
    const dht = Uint8Array.from([0xff, 0xc4, 0x00, 0x03, 0x00]);
    const bytes = jpegBytes(300, 200);
    const combined = new Uint8Array(bytes.length + dht.length);
    combined.set(bytes.slice(0, 2));
    combined.set(dht, 2);
    combined.set(bytes.slice(2), 2 + dht.length);
    expect(readImage(combined)).toEqual({ type: 'image/jpeg', width: 300, height: 200 });
  });
});
