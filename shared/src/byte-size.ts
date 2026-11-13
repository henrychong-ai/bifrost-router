/**
 * The one byte-size formatter: the MCP storage tools and the dashboard's
 * Dashboard, Storage, Downloads and Proxy pages all format sizes with it.
 *
 * Binary steps of 1024 with the conventional short unit names: whole bytes
 * below 1 KB (`512 B`), one decimal for KB and MB (`1.5 KB`), and
 * `gigabyteDigits` decimals (default 1) for GB and TB, the largest unit. The
 * analytics tables (Downloads, Proxy) show two decimals from GB up. A value
 * that is not a finite, non-negative number (never a real size) formats as
 * `0 B`.
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const GIGABYTE_UNIT = 3;

export interface ByteSizeOptions {
  /** Decimals shown for GB and TB (default 1). */
  gigabyteDigits?: number;
}

export function formatByteSize(bytes: number, options: ByteSizeOptions = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : unit >= GIGABYTE_UNIT ? (options.gigabyteDigits ?? 1) : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}
