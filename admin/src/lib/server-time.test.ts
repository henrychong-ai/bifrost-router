/**
 * The server's clock on an answer (v1.38.0): X-Server-Time only when it is a
 * plausible safe integer inside the Date header's second (±1 s), else the end
 * of that second.
 */
import { describe, expect, it } from 'vitest';
import { serverTimeOf, TOMBSTONE_SKEW_MARGIN_MS } from './server-time';

const DATE = 'Tue, 06 Oct 2026 10:00:00 GMT';
const SECOND = Date.parse('2026-10-06T10:00:00Z');

describe('serverTimeOf', () => {
  it('prefers a valid millisecond X-Server-Time', () => {
    const headers = new Headers({ Date: DATE, 'X-Server-Time': String(SECOND + 123) });
    expect(serverTimeOf(headers)).toBe(SECOND + 123);
    // A plain record (lower- or mixed-case names) reads the same way
    expect(serverTimeOf({ date: DATE, 'x-server-time': String(SECOND + 456) })).toBe(SECOND + 456);
    expect(serverTimeOf({ date: DATE, 'X-Server-Time': String(SECOND + 789) })).toBe(SECOND + 789);
  });

  it('accepts a value up to a second either side of the Date second', () => {
    expect(serverTimeOf({ date: DATE, 'x-server-time': String(SECOND - 1000) })).toBe(
      SECOND - 1000,
    );
    expect(serverTimeOf({ date: DATE, 'x-server-time': String(SECOND + 1999) })).toBe(
      SECOND + 1999,
    );
  });

  it.each([
    ['zero', '0'],
    ['beyond the safe integers', '9999999999999999'],
    ['before the Date second by more than a second', String(SECOND - 1001)],
    ['after the Date second by more than a second', String(SECOND + 2000)],
    ['implausibly early, though digits', '1000'],
    ['empty', ''],
    ['padded', ` ${SECOND}`],
    ['signed', `-${SECOND}`],
    ['an exponent', '1.7e12'],
    ['a decimal', `${SECOND}.5`],
    ['not digits', 'soon'],
  ])('falls back to the end of the Date second for a value %s', (_label, value) => {
    expect(serverTimeOf({ date: DATE, 'x-server-time': value })).toBe(SECOND + 999);
  });

  it('falls back to the Date header when X-Server-Time is missing or not text', () => {
    expect(serverTimeOf({ date: DATE })).toBe(SECOND + 999);
    expect(serverTimeOf({ date: DATE, 'x-server-time': SECOND + 1 })).toBe(SECOND + 999);
  });

  it('answers undefined without a readable Date, even with an X-Server-Time', () => {
    expect(serverTimeOf({ 'x-server-time': String(SECOND + 1) })).toBeUndefined();
    expect(serverTimeOf({ date: 'garbage', 'x-server-time': String(SECOND + 1) })).toBeUndefined();
    expect(serverTimeOf(new Headers())).toBeUndefined();
    expect(serverTimeOf(null)).toBeUndefined();
    expect(serverTimeOf('Date')).toBeUndefined();
  });

  it('keeps a tombstone margin of at least a second', () => {
    expect(TOMBSTONE_SKEW_MARGIN_MS).toBeGreaterThanOrEqual(1000);
  });
});
