import type { QRCode } from '@bifrost/shared';
import {
  parseStoredQR,
  QRDesignSchema,
  serializePayload,
  VcardPayloadSchema,
  vcardHasName,
  WifiAuthSchema,
} from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import {
  designFromState,
  newPhoneRow,
  payloadFromState,
  type QrFormState,
  qrEditPatch,
  stateFromQr,
  suggestQrId,
  WIFI_AUTH_TRIGGER_LABELS,
} from './qr-form-state';

/**
 * Unit tests for the pure form-state derivation. Hidden fields keep their
 * state, so derivation must EXCLUDE inapplicable values: a stale credential
 * must never reach the record.
 */

function wifiState(patch: Partial<QrFormState>): QrFormState {
  return { ...stateFromQr(), type: 'wifi', ssid: 'Corp', ...patch };
}

describe('payloadFromState — unknown type', () => {
  it('refuses a type outside the QR type list instead of returning nothing', () => {
    expect(() => payloadFromState({ ...stateFromQr(), type: 'bogus' as never })).toThrow(
      'Unsupported QR type: bogus',
    );
  });
});

describe('payloadFromState — wifi credential exclusions', () => {
  it('TLS NEVER submits a password, even when stale state holds one', () => {
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
    expect(payload['eapMethod']).toBe('TLS');
    expect(payload['identity']).toBe('device01');
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
    expect(withBoth['logoAspectRatio']).toBe(5.29);

    const ratioOnly = designFromState({ ...stateFromQr(), logoAspectRatio: 5.29 });
    expect(ratioOnly).not.toHaveProperty('logoAspectRatio');
    expect(ratioOnly).not.toHaveProperty('logoDataUri');
  });
});

const base = (patch: Partial<QrFormState>): QrFormState => ({ ...stateFromQr(), ...patch });

describe('stateFromQr — edit round-trip', () => {
  it('preserves logoAspectRatio through state → design (full-replacement PUT safety)', () => {
    const qr = {
      id: 'x',
      type: 'url',
      payload: { url: 'https://x.example' },
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
    expect(design['logoAspectRatio']).toBe(5.29);
    expect(design['logoDataUri']).toBe('data:image/png;base64,aGk=');
  });

  it('opens the edit dialog in Custom so stored designs are never clobbered', () => {
    const qr = {
      id: 'x',
      type: 'url',
      payload: { url: 'https://x.example' },
      design: { fg: '#111111', bg: '#ffffff', size: 512, margin: 4, errorCorrection: 'M' },
    } as unknown as QRCode;
    expect(stateFromQr(qr).brandSel).toBe('custom');
    expect(stateFromQr().brandSel).toBe('auto');
  });

  describe('suggestQrId (Reference prefill; description decoupled)', () => {
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
      expect(suggestQrId(base({ type: 'vcard', firstName: 'Jane', surname: 'Doe' }))).toBe(
        'jane-doe',
      );
      expect(suggestQrId(base({ type: 'vcard', surname: ' Doe ' }))).toBe('doe');
      expect(suggestQrId(base({ type: 'vcard', displayName: 'Dr Jane Doe' }))).toBe('dr-jane-doe');
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

  describe('wifi security trigger labels', () => {
    it('covers every auth option the schema accepts', () => {
      // Keyed off the canonical enum, so a new auth category fails here
      // until it gets a trigger label — the map can never silently
      // fall back to a blank trigger.
      expect(Object.keys(WIFI_AUTH_TRIGGER_LABELS).toSorted()).toEqual(
        WifiAuthSchema.options.toSorted(),
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

/** Phone rows without their form-only ids. */
function rows(phones: QrFormState['phones']) {
  return phones.map(({ number, type }) => ({ number, type }));
}

/** A stored contact card with `payload` and `design` (defaults applied). */
function card(payload: Record<string, unknown>, design: Record<string, unknown> = {}): QRCode {
  return {
    id: 'card',
    domain: 'example.com',
    type: 'vcard',
    payload,
    design: QRDesignSchema.parse(design),
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test',
  };
}

describe('contact card form (vCard 3.0, v1.42.0)', () => {
  it('starts a new card with one blank work phone', () => {
    const state = stateFromQr();
    expect(rows(state.phones)).toEqual([{ number: '', type: 'work' }]);
    expect(payloadFromState({ ...state, type: 'vcard', firstName: 'Jane' })).toEqual({
      firstName: 'Jane',
    });
  });

  it('submits every filled field trimmed, blank phones and address parts left out', () => {
    const payload = payloadFromState({
      ...stateFromQr(),
      type: 'vcard',
      firstName: ' Jane ',
      surname: 'Doe',
      displayName: ' ',
      org: 'Example Widgets, Inc.',
      title: 'Head of Operations',
      phones: [
        newPhoneRow(' +1 555 0100 ', 'work'),
        newPhoneRow('  ', 'cell'),
        newPhoneRow('+1 555 0199', 'main'),
      ],
      email: 'jane.doe@example.com',
      vurl: 'example.com',
      street: 'Suite 12, 100 Main Street',
      city: 'Springfield',
      region: '',
      postcode: '12345',
      country: '',
    });
    expect(payload).toEqual({
      firstName: 'Jane',
      surname: 'Doe',
      org: 'Example Widgets, Inc.',
      title: 'Head of Operations',
      phones: [
        { number: '+1 555 0100', type: 'work' },
        { number: '+1 555 0199', type: 'main' },
      ],
      email: 'jane.doe@example.com',
      url: 'example.com',
      address: { street: 'Suite 12, 100 Main Street', city: 'Springfield', postcode: '12345' },
    });
    expect(VcardPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('round-trips a stored card through the form unchanged', () => {
    const payload = {
      firstName: 'Jane',
      surname: 'Doe',
      displayName: 'Dr Jane Doe',
      phones: [
        { number: '+1 555 0101', type: 'fax' },
        { number: '+1 555 0102', type: 'cell' },
      ],
      url: 'https://example.com',
      address: { region: 'Example State', country: 'Exampleland' },
    };
    expect(payloadFromState(stateFromQr(card(payload)))).toEqual(payload);
  });

  it('opens a legacy card with its name as the first name and its phone as a work number', () => {
    const legacy = card({ name: 'Jane Doe', phone: '+1 555 0100', org: 'Example' });
    const state = stateFromQr(legacy);
    expect(state).toMatchObject({
      firstName: 'Jane Doe',
      surname: '',
      phones: [{ number: '+1 555 0100', type: 'work' }],
      org: 'Example',
    });
    const payload = payloadFromState(state);
    expect(payload).toEqual({
      firstName: 'Jane Doe',
      org: 'Example',
      phones: [{ number: '+1 555 0100', type: 'work' }],
    });
    // The name encodes as before; the phone becomes the preferred work number
    expect(serializePayload('vcard', payload as never)).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane Doe;;;\r\nFN:Jane Doe\r\nORG:Example\r\nTEL;TYPE=WORK,VOICE,PREF:+1 555 0100\r\nEND:VCARD',
    );
    // A legacy card with an empty phone opens with one blank row
    expect(rows(stateFromQr(card({ name: 'A', phone: '' })).phones)).toEqual([
      { number: '', type: 'work' },
    ]);
    // A blank (whitespace-only) legacy phone counts as absent: one blank row
    expect(rows(stateFromQr(card({ name: 'Jane', phone: '   ' })).phones)).toEqual([
      { number: '', type: 'work' },
    ]);
  });

  it('opens a legacy phone beside a blank stored phone entry as a work row; an unchanged edit sends no payload', () => {
    const stored = card({
      firstName: 'Jane',
      phone: '+1 555 0100',
      phones: [{ number: '', type: 'work' }],
    });
    expect(parseStoredQR(stored)).not.toBeNull();
    const state = stateFromQr(stored);
    expect(rows(state.phones)).toEqual([{ number: '+1 555 0100', type: 'work' }]);
    expect(qrEditPatch(stored, state, 'example.com')).not.toHaveProperty('payload');
    // Blank entries alone open as the one blank row to type into
    expect(
      rows(
        stateFromQr(card({ firstName: 'Jane', phones: [{ number: ' ', type: 'cell' }] })).phones,
      ),
    ).toEqual([{ number: '', type: 'work' }]);
  });

  it('reads damaged phone entries and address defensively', () => {
    const state = stateFromQr(
      card({
        firstName: 'A',
        phones: [null, 'x', { number: 5, type: 'pager' }, { number: '+1 555 0100', type: 'main' }],
      }),
    );
    // A number that is not text reads as blank and is skipped, as encoded
    expect(rows(state.phones)).toEqual([{ number: '+1 555 0100', type: 'main' }]);
    expect(stateFromQr(card({ firstName: 'A', address: 'not an object' })).street).toBe('');
  });

  it('opens stored text without control characters: CR and LF kept in text, dropped in TEL and EMAIL', () => {
    const state = stateFromQr(
      card({
        firstName: 'A\u0000B',
        title: 'Line one\nLine\u0007 two',
        email: 'a@\r\nexample.com',
        phones: [{ number: '+1\n555', type: 'cell' }],
        address: { city: 'Spring\u0001field' },
      }),
    );
    expect(state).toMatchObject({
      firstName: 'AB',
      title: 'Line one\nLine two',
      email: 'a@example.com',
      city: 'Springfield',
    });
    expect(rows(state.phones)).toEqual([{ number: '+1555', type: 'cell' }]);
    expect(VcardPayloadSchema.safeParse(payloadFromState(state)).success).toBe(true);
  });

  it('knows when there is a name to preview', () => {
    expect(vcardHasName(stateFromQr())).toBe(false);
    expect(vcardHasName({ ...stateFromQr(), firstName: '  ' })).toBe(false);
    for (const field of ['firstName', 'surname', 'displayName'] as const) {
      expect(vcardHasName({ ...stateFromQr(), [field]: 'x' })).toBe(true);
    }
  });

  it('gives each phone row its own form-only id, never submitted', () => {
    const state = { ...stateFromQr(), type: 'vcard' as const, firstName: 'A' };
    const phones = [newPhoneRow('+1 555 0100'), newPhoneRow('+1 555 0101', 'cell')];
    expect(new Set([state.phones[0]?.id, ...phones.map(phone => phone.id)]).size).toBe(3);
    expect(payloadFromState({ ...state, phones })['phones']).toEqual([
      { number: '+1 555 0100', type: 'work' },
      { number: '+1 555 0101', type: 'cell' },
    ]);
  });

  it('opens a card with a blank first name beside a legacy name showing the name', () => {
    expect(stateFromQr(card({ firstName: ' ', name: 'Jane Doe' })).firstName).toBe('Jane Doe');
    expect(stateFromQr(card({ firstName: 'Jane', name: 'Ignored' })).firstName).toBe('Jane');
    expect(stateFromQr(card({ firstName: ' ' })).firstName).toBe(' ');
  });

  it('opens a stored website without its control characters; the encoded code is unchanged', () => {
    const stored = card({ name: 'A', url: 'https://a.example\nB' });
    const state = stateFromQr(stored);
    expect(state.vurl).toBe('https://a.exampleB');
    expect(VcardPayloadSchema.safeParse(payloadFromState({ ...state, title: 'New' })).success).toBe(
      true,
    );
    // The form submits the legacy name as the first name, which encodes the same
    expect(serializePayload('vcard', payloadFromState(state) as never)).toBe(
      serializePayload('vcard', stored.payload),
    );
    expect(serializePayload('vcard', stored.payload)).toContain('\r\nURL:https://a.exampleB\r\n');
  });
});
