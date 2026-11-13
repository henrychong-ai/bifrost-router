/**
 * Test-only access to qrcode-svg 1.1.0's internals: the symbol the library
 * builds for a content string and the bytes it encodes and writes. One copy
 * for every test that checks the patched encoder (`qr-render-bom.test.ts`,
 * `qr-render-utf8.test.ts`), so a library upgrade that moves these internals
 * is fixed in one place. Not part of the package build (tsconfig excludes
 * `*.test-support.ts`), and never imported by runtime code.
 */
import QRCode from 'qrcode-svg';
import { isRecord } from './guards.js';

/** One data segment of a symbol (the library's QR8bitByte). */
export interface QrSegment {
  parsedData: number[];
  getLength(): number;
  write(buffer: { put(num: number, length: number): void }): void;
}

/** A symbol's model: its version, data segments, and the call that adds one. */
export interface QrModel {
  typeNumber: number;
  dataList: QrSegment[];
  addData(data: string): void;
}

/** Whether `value` looks like the library's model; throws when its internals moved. */
function asModel(value: unknown): QrModel {
  const inner = isRecord(value) ? value['qrcode'] : undefined;
  if (
    !isRecord(inner) ||
    typeof inner['typeNumber'] !== 'number' ||
    !Array.isArray(inner['dataList']) ||
    typeof inner['addData'] !== 'function'
  ) {
    throw new Error('qrcode-svg internals changed');
  }
  return inner as unknown as QrModel;
}

/** The symbol the library builds for `content`: its version and data segments. */
export function qrSymbol(content: string, ecl: 'L' | 'M' | 'Q' | 'H' = 'M'): QrModel {
  return asModel(new QRCode({ content, ecl }));
}

/** The bytes the library encoded for `content` (its segments' `parsedData`). */
export function encodedBytes(content: string): number[] {
  return qrSymbol(content).dataList.flatMap(segment => {
    const data: unknown = segment.parsedData;
    if (!Array.isArray(data) || !data.every(byte => typeof byte === 'number')) {
      throw new Error('qrcode-svg internals changed');
    }
    return data;
  });
}

/**
 * The bytes the library writes into the symbol for `content`, captured from
 * each segment's `write`, with the bit length of every put and each
 * segment's declared length, for the caller to check.
 */
export function writtenBytes(content: string): {
  bytes: number[];
  putLengths: number[];
  segmentLengths: number[];
} {
  const bytes: number[] = [];
  const putLengths: number[] = [];
  const segmentLengths: number[] = [];
  for (const segment of qrSymbol(content).dataList) {
    segment.write({
      put(num, length) {
        putLengths.push(length);
        bytes.push(num);
      },
    });
    segmentLengths.push(segment.getLength());
  }
  return { bytes, putLengths, segmentLengths };
}

/** The UTF-8 bytes of `content`. */
export const utf8 = (content: string): number[] => [...new TextEncoder().encode(content)];
