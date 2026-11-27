/**
 * Minimal image headers for the link-preview tests (v1.48.0): just enough
 * bytes for a reader of the PNG IHDR chunk or the JPEG frame header. Not
 * decodable pictures; the Worker never decodes, it reads the header only.
 */

/** A PNG signature and IHDR chunk declaring `width` x `height`. */
export function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

/**
 * A JPEG: SOI, an APP0 segment, optionally fill bytes and a restart marker,
 * then a baseline (or progressive) frame header declaring `width` x `height`.
 */
export function jpegBytes(
  width: number,
  height: number,
  options: { progressive?: boolean; fill?: boolean; rst?: boolean } = {},
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  // APP0 "JFIF\0" with a 16-byte segment
  parts.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  if (options.rst) parts.push(0xff, 0xd0);
  parts.push(0xff);
  if (options.fill) parts.push(0xff, 0xff);
  parts.push(options.progressive ? 0xc2 : 0xc0, 0x00, 0x11, 8);
  parts.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  parts.push(3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xd9);
  return Uint8Array.from(parts);
}
