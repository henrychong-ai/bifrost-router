import { isRecord } from './guards.js';

/**
 * `value` as JSON with every object's keys in sorted order, at every level
 * (v1.38.0): the same text for the same value whatever order its keys arrive
 * in. A key whose value JSON cannot hold (undefined, a function) is left out,
 * as `JSON.stringify` does; in an array such a value is written as `null`.
 *
 * The one serialiser behind every "is this the same value" comparison: the
 * Cloudflare audit poller's id for an entry without one, the dashboard's
 * check that a stored QR code is the one a create sent, and the KV layer's
 * check that a moved route is still the record its handler read.
 *
 * Bundled by the dashboard, so it sorts a copy in place: the dashboard's
 * build target predates `Array#toSorted`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    keys.sort();
    const fields = keys
      .filter(key => value[key] !== undefined && typeof value[key] !== 'function')
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
