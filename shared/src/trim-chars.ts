/**
 * Linear trims (v1.39.0). A trailing-run regex such as `/[-.]+$/` or `/-+$/`
 * is polynomial (code scanning): on a long run that does not end the string
 * the engine retries the run from every one of its characters. These scan
 * once from the end (or the start) instead, with the same results.
 */

/** `value` without the trailing characters that are in `chars`. */
export function trimEndChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value.charAt(end - 1))) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** `value` without the leading characters that are in `chars`. */
export function trimStartChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value.charAt(start))) start += 1;
  return start === 0 ? value : value.slice(start);
}
