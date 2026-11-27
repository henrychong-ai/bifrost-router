/**
 * The format and pixel size of a JPEG or PNG, read from its own bytes
 * (v1.48.0: a link preview's `og:image:width` and `og:image:height`).
 *
 * Pure and bounded: it reads only the bytes it is given, never trusts a
 * declared content type, and answers why when the bytes are not a complete
 * PNG header or a JPEG whose frame header (SOF) comes before the image data,
 * when a side is over IMAGE_DIMENSION_MAX, or when the JPEG frame has an
 * unsupported component layout. No dependency: the two headers are fixed binary layouts.
 */

import { PREVIEW_IMAGE_DIMENSION_MAX } from '@bifrost/shared';

export interface ImageSize {
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The largest width or height accepted (shared PREVIEW_IMAGE_DIMENSION_MAX). */
export const IMAGE_DIMENSION_MAX = PREVIEW_IMAGE_DIMENSION_MAX;

/** Why bytes are not a usable preview image. */
export type ImageRefusalReason = 'not-image' | 'too-large' | 'unsupported-jpeg';

/** The answer of {@link readImage}: a size, or the reason there is none. */
export type ImageReading = ImageSize | { reason: ImageRefusalReason };

/** A size, or the reason it is unusable: zero is no image, over the cap too large. */
function sized(type: ImageSize['type'], width: number, height: number): ImageReading {
  if (width < 1 || height < 1) return { reason: 'not-image' };
  if (width > IMAGE_DIMENSION_MAX || height > IMAGE_DIMENSION_MAX) return { reason: 'too-large' };
  return { type, width, height };
}

const NOT_IMAGE = { reason: 'not-image' } as const;

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

/**
 * A PNG: the signature, then a complete IHDR chunk (length 13, all 13 data
 * bytes and its CRC present) with legal dimensions (1 to 2^31 - 1, here
 * capped at IMAGE_DIMENSION_MAX).
 */
function pngSize(bytes: Uint8Array): ImageReading {
  // 8 signature + 4 length + 4 type + 13 data + 4 CRC
  if (bytes.length < 33 || readUint32(bytes, 8) !== 13) return NOT_IMAGE;
  // Chunk type at 12..16 must be IHDR, the first chunk of every PNG
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return NOT_IMAGE;
  }
  return sized('image/png', readUint32(bytes, 16), readUint32(bytes, 20));
}

/**
 * Start-of-frame markers that carry the frame size: SOF0–SOF15 except DHT
 * (C4), JPG (C8) and DAC (CC), which share the range but are not frames.
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** A JPEG: walk the marker segments to the first frame header. */
function jpegSize(bytes: Uint8Array): ImageReading {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return NOT_IMAGE;
    // Any number of 0xFF fill bytes may precede a marker
    let markerAt = offset + 1;
    while (bytes[markerAt] === 0xff) markerAt++;
    const marker = bytes[markerAt];
    if (marker === undefined) return NOT_IMAGE;
    offset = markerAt + 1;
    // Standalone markers carry no length: TEM, RST0–7, and a stray SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image, or the scan data, before any frame header
    if (marker === 0xd9 || marker === 0xda) return NOT_IMAGE;
    if (offset + 2 > bytes.length) return NOT_IMAGE;
    const length = readUint16(bytes, offset);
    if (length < 2) return NOT_IMAGE;
    if (isStartOfFrame(marker)) {
      // length(2) precision(1) height(2) width(2) components(1), then three
      // bytes per component (1 grey, 3 YCbCr or RGB, 4 CMYK); the whole
      // declared segment must be within the bytes read
      if (offset + length > bytes.length || length < 8) return NOT_IMAGE;
      const components = bytes[offset + 7] ?? 0;
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) {
        return { reason: 'unsupported-jpeg' };
      }
      return sized('image/jpeg', readUint16(bytes, offset + 5), readUint16(bytes, offset + 3));
    }
    offset += length;
  }
  return NOT_IMAGE;
}

/** The format and size of `bytes` as a PNG or a JPEG, or why they are not one. */
export function readImage(bytes: Uint8Array): ImageReading {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return pngSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
  return NOT_IMAGE;
}
