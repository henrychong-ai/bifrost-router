/**
 * Dashboard reads of stored and remote JSON (v1.38.0): parsed as unknown and
 * validated, so a malformed attachment or identity answer degrades instead of
 * reaching the UI as something else.
 */
import { describe, expect, it } from 'vitest';
import { parseStoredCapture, parseTailscaleIdentity } from './stored-json';

describe('parseStoredCapture', () => {
  it('reads a valid bundle, filling absent lists', () => {
    expect(
      parseStoredCapture(JSON.stringify({ console: [{ level: 'error', message: 'x', ts: 1 }] })),
    ).toEqual({ console: [{ level: 'error', message: 'x', ts: 1 }], network: [], breadcrumbs: [] });
  });

  it.each([
    ['not JSON', '{"console":'],
    ['null', 'null'],
    ['entries of the wrong shape', JSON.stringify({ network: [{ url: 5 }] })],
  ])('returns null for %s', (_label, text) => {
    expect(parseStoredCapture(text)).toBeNull();
  });
});

describe('parseTailscaleIdentity', () => {
  it('reads a valid identity', () => {
    const identity = { login: 'a', name: null, profilePic: null, isAuthenticated: true };
    expect(parseTailscaleIdentity(identity)).toEqual(identity);
  });

  it.each([
    ['null', null],
    ['a string', 'a'],
    ['a wrong-typed field', { login: 5, name: null, profilePic: null, isAuthenticated: true }],
    ['a missing flag', { login: 'a', name: null, profilePic: null }],
  ])('returns the signed-out identity for %s', (_label, value) => {
    expect(parseTailscaleIdentity(value)).toEqual({
      login: null,
      name: null,
      profilePic: null,
      isAuthenticated: false,
    });
  });
});
