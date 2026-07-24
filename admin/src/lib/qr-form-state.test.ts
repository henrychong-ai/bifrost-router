import { describe, expect, it } from 'vitest';
import type { QRCode } from '@bifrost/shared';
import { WifiAuthSchema } from '@bifrost/shared';
import {
  payloadFromState,
  designFromState,
  stateFromQr,
  suggestQrId,
  WIFI_AUTH_TRIGGER_LABELS,
  type QrFormState,
} from './qr-form-state';

/**
 * Unit tests for the pure form-state derivation — extracted in the v1.58.0
 * review round after codex found the stale-credential path (MAJOR): hidden
 * fields keep their state, so derivation must EXCLUDE inapplicable values.
 */

function wifiState(patch: Partial<QrFormState>): QrFormState {
  return { ...stateFromQr(), type: 'wifi', ssid: 'Corp', ...patch };
}

describe('payloadFromState — wifi credential exclusions', () => {
  it('TLS NEVER submits a password, even when stale state holds one (review MAJOR)', () => {
    // User typed a password under PEAP, then switched to TLS (field hidden).
    const payload = payloadFromState(
      wifiState({
        auth: 'WPA2-EAP',
        eapMethod: 'TLS',
        identity: 'device01',
        password: 'stale-secret-from-peap',
      }),
    );
    expect(payload).not.toHaveProperty('password');
    expect(payload.eapMethod).toBe('TLS');
    expect(payload.identity).toBe('device01');
  });

  it('phase2 is emitted only for tunneled methods (PEAP/TTLS), never TLS/PWD', () => {
    const base = { auth: 'WPA2-EAP' as const, identity: 'u', password: 'p', phase2: 'MSCHAPV2' };
    expect(payloadFromState(wifiState({ ...base, eapMethod: 'PEAP' }))).toHaveProperty(
      'phase2',
      'MSCHAPV2',
    );
    expect(payloadFromState(wifiState({ ...base, eapMethod: 'TTLS' }))).toHaveProperty('phase2');
    expect(payloadFromState(wifiState({ ...base, eapMethod: 'TLS' }))).not.toHaveProperty('phase2');
    expect(payloadFromState(wifiState({ ...base, eapMethod: 'PWD' }))).not.toHaveProperty('phase2');
  });

  it('PEAP keeps its password; personal WPA behaviour unchanged; nopass drops it', () => {
    expect(
      payloadFromState(
        wifiState({ auth: 'WPA2-EAP', eapMethod: 'PEAP', identity: 'u', password: 'p' }),
      ),
    ).toHaveProperty('password', 'p');
    expect(payloadFromState(wifiState({ auth: 'WPA', password: 'p' }))).toHaveProperty(
      'password',
      'p',
    );
    expect(payloadFromState(wifiState({ auth: 'nopass', password: 'stale' }))).not.toHaveProperty(
      'password',
    );
  });

  it('enterprise fields are never emitted for personal/open auth (stale-state exclusion)', () => {
    const payload = payloadFromState(
      wifiState({ auth: 'WPA', password: 'p', identity: 'stale-id', eapMethod: 'PEAP' }),
    );
    expect(payload).not.toHaveProperty('identity');
    expect(payload).not.toHaveProperty('eapMethod');
    expect(payload).not.toHaveProperty('phase2');
    expect(payload).not.toHaveProperty('anonymousIdentity');
  });
});

describe('designFromState — logoAspectRatio emission', () => {
  it('emits the ratio only alongside a logo, and never without one', () => {
    const withBoth = designFromState({
      ...stateFromQr(),
      logoDataUri: 'data:image/png;base64,aGk=',
      logoAspectRatio: 5.29,
    });
    expect(withBoth.logoAspectRatio).toBe(5.29);

    const ratioOnly = designFromState({ ...stateFromQr(), logoAspectRatio: 5.29 });
    expect(ratioOnly).not.toHaveProperty('logoAspectRatio');
    expect(ratioOnly).not.toHaveProperty('logoDataUri');
  });
});

describe('stateFromQr — edit round-trip', () => {
  it('preserves logoAspectRatio through state → design (full-replacement PUT safety)', () => {
    const qr = {
      id: 'x',
      type: 'url',
      payload: { url: 'https://x' },
      design: {
        fg: '#001757',
        bg: '#ffffff',
        size: 512,
        margin: 4,
        errorCorrection: 'H',
        logoDataUri: 'data:image/png;base64,aGk=',
        logoAspectRatio: 5.29,
      },
    } as unknown as QRCode;
    const design = designFromState(stateFromQr(qr));
    expect(design.logoAspectRatio).toBe(5.29);
    expect(design.logoDataUri).toBe('data:image/png;base64,aGk=');
  });

  it('opens the edit dialog in Custom so stored designs are never clobbered', () => {
    const qr = {
      id: 'x',
      type: 'url',
      payload: { url: 'https://x' },
      design: { fg: '#111111', bg: '#ffffff', size: 512, margin: 4, errorCorrection: 'M' },
    } as unknown as QRCode;
    expect(stateFromQr(qr).brandSel).toBe('custom');
    expect(stateFromQr().brandSel).toBe('auto');
  });

  describe('suggestQrId (Reference prefill, v1.58.5; description decoupled v1.58.7)', () => {
    const base = (patch: Partial<QrFormState>): QrFormState => ({ ...stateFromQr(), ...patch });

    it('ignores the description — Reference and Description are independent fields', () => {
      expect(suggestQrId(base({ description: 'Office WiFi', type: 'wifi', ssid: 'CorpNet' }))).toBe(
        'corpnet',
      );
      expect(suggestQrId(base({ description: 'Office WiFi', type: 'wifi' }))).toBe('');
    });

    it('suggests from the most identifying field for each type', () => {
      expect(suggestQrId(base({ type: 'wifi', ssid: 'Corp Guest' }))).toBe('corp-guest');
      expect(suggestQrId(base({ type: 'url', url: 'https://www.example.com/listings' }))).toBe(
        'example-com',
      );
      expect(suggestQrId(base({ type: 'vcard', name: 'Henry Chong' }))).toBe('henry-chong');
      expect(suggestQrId(base({ type: 'text', text: 'Meeting room 3' }))).toBe('meeting-room-3');
    });

    it('returns empty while there is nothing to go on, so the field is left alone', () => {
      expect(suggestQrId(base({}))).toBe('');
      expect(suggestQrId(base({ type: 'url', url: 'not-a-url-yet' }))).toBe('');
    });

    it('never suggests a cross-type field (a wifi SSID must not name a url QR)', () => {
      expect(suggestQrId(base({ type: 'url', ssid: 'CorpNet', url: '' }))).toBe('');
    });
  });

  describe('wifi security trigger labels (v1.58.3)', () => {
    it('covers every auth option the schema accepts', () => {
      // Keyed off the canonical enum, so a new auth category fails here
      // until it gets a trigger label — the map can never silently
      // fall back to a blank trigger.
      expect(Object.keys(WIFI_AUTH_TRIGGER_LABELS).sort()).toEqual(
        [...WifiAuthSchema.options].sort(),
      );
    });

    it('keeps every trigger label short enough for the half-width column', () => {
      // The bug this fixes: "Password-protected (WPA / WPA2 / WPA3)" (38
      // chars) overflowed its border and ran under the chevron. 24 is
      // comfortably inside the observed ~34-char budget.
      for (const label of Object.values(WIFI_AUTH_TRIGGER_LABELS)) {
        expect(label.length).toBeLessThanOrEqual(24);
        expect(label.trim()).toBe(label);
      }
    });

    it('drops the protocol list from the trigger only — never the category itself', () => {
      expect(WIFI_AUTH_TRIGGER_LABELS.WPA).toBe('Password-protected');
      expect(WIFI_AUTH_TRIGGER_LABELS.WPA).not.toContain('WPA2');
      expect(WIFI_AUTH_TRIGGER_LABELS.WEP).toContain('legacy');
      expect(WIFI_AUTH_TRIGGER_LABELS['WPA2-EAP']).toContain('802.1X');
    });
  });
});
