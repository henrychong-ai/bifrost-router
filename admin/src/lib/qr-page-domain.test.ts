import { describe, expect, it } from 'vitest';
import { initialQrPageDomain, qrPageNavDomain } from './qr-page-domain';

const allowed = ['example.com', 'secondary.example.net', 'user1.example.com'];

describe('initialQrPageDomain', () => {
  it('opens on the domain navigation state names', () => {
    expect(initialQrPageDomain({ domain: 'secondary.example.net' }, allowed)).toBe(
      'secondary.example.net',
    );
  });

  it('falls back to the first offered domain for missing, foreign or malformed state', () => {
    for (const state of [null, undefined, {}, { domain: 'evil.test' }, { domain: 7 }, 'x']) {
      expect(initialQrPageDomain(state, allowed)).toBe('example.com');
    }
    expect(initialQrPageDomain(null, [])).toBe('example.com');
  });
});

describe('qrPageNavDomain', () => {
  it('reads a string domain from navigation state and nothing else', () => {
    expect(qrPageNavDomain({ domain: 'secondary.example.net' })).toBe('secondary.example.net');
    for (const state of [null, undefined, {}, { domain: 7 }, 'secondary.example.net']) {
      expect(qrPageNavDomain(state)).toBeUndefined();
    }
  });
});
