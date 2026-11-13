import { describe, expect, it } from 'vitest';
import { formatByteSize } from './byte-size';
import { formatByteSize as fromIndex } from './index';

describe('formatByteSize', () => {
  it('formats whole bytes below 1 KB', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(1)).toBe('1 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1023)).toBe('1023 B');
  });

  it('formats each larger unit with one decimal at its exact boundary', () => {
    expect(formatByteSize(1024)).toBe('1.0 KB');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(10240)).toBe('10.0 KB');
    expect(formatByteSize(1024 ** 2)).toBe('1.0 MB');
    expect(formatByteSize(2.5 * 1024 ** 2)).toBe('2.5 MB');
    expect(formatByteSize(1024 ** 3)).toBe('1.0 GB');
    expect(formatByteSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatByteSize(1024 ** 4)).toBe('1.0 TB');
  });

  it('keeps TB as the largest unit', () => {
    expect(formatByteSize(2048 * 1024 ** 4)).toBe('2048.0 TB');
  });

  it('shows the requested decimals from GB up only', () => {
    const twoDigits = { gigabyteDigits: 2 };
    expect(formatByteSize(1023, twoDigits)).toBe('1023 B');
    expect(formatByteSize(1024, twoDigits)).toBe('1.0 KB');
    expect(formatByteSize(1024 ** 2, twoDigits)).toBe('1.0 MB');
    expect(formatByteSize(1.5 * 1024 ** 3, twoDigits)).toBe('1.50 GB');
    expect(formatByteSize(1024 ** 4, twoDigits)).toBe('1.00 TB');
  });

  it('formats a value that is not a real size as 0 B', () => {
    expect(formatByteSize(-1)).toBe('0 B');
    expect(formatByteSize(Number.NaN)).toBe('0 B');
    expect(formatByteSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('is exported from the package root', () => {
    expect(fromIndex).toBe(formatByteSize);
  });
});
