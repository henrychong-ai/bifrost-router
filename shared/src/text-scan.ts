/**
 * Linear scans for unpaired UTF-16 surrogates (v1.42.1), shared by the QR
 * payload write rule (`qr.ts`) and the dashboard's QR edit form. Neither uses
 * `String.prototype.isWellFormed` or `toWellFormed`: the dashboard's build
 * target lacks them.
 */

/**
 * Whether `value` holds an unpaired surrogate: a high surrogate not followed
 * by a low one, or a low surrogate not preceded by a high one. Such a string
 * is not well-formed UTF-16 and has no UTF-8 form; `TextEncoder` writes
 * U+FFFD for each one. The negation of `String.prototype.isWellFormed`.
 */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    }
  }
  return false;
}

/**
 * `value` with each unpaired surrogate replaced by U+FFFD, exactly what
 * `TextEncoder` encodes for it: the dashboard opens a stored QR payload this
 * way, so the form shows what the code encodes and an edit passes the write
 * rule. Linear.
 */
export function replaceLoneSurrogates(value: string): string {
  if (!hasLoneSurrogate(value)) return value;
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.slice(index, index + 2);
        index += 1;
        continue;
      }
      out += '�';
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += '�';
    } else {
      out += value.charAt(index);
    }
  }
  return out;
}
