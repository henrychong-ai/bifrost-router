import { describe, it, expect } from 'vitest';
import {
  QR_TYPES,
  QR_ID_REGEX,
  MAX_QR_PAYLOAD_LENGTH,
  QR_LOGO_MAX_BYTES,
  QRTypeSchema,
  UrlPayloadSchema,
  TextPayloadSchema,
  WifiPayloadSchema,
  VcardPayloadSchema,
  QRDesignSchema,
  QRCodeSchema,
  CreateQRInputSchema,
  UpdateQRInputSchema,
  QRListQuerySchema,
  escapeMecard,
  serializePayload,
  generateQrId,
  normalizeQrId,
  normalizeQrIdInput,
} from './qr.js';

/** Build a base64 data URI whose decoded size is exactly `bytes`. */
function logoDataUri(bytes: number, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from('x'.repeat(bytes)).toString('base64')}`;
}

describe('qr contract', () => {
  describe('QR_TYPES / QRTypeSchema', () => {
    it('covers exactly the four MVP types', () => {
      expect(QR_TYPES).toEqual(['url', 'text', 'vcard', 'wifi']);
    });

    it('rejects unknown types', () => {
      expect(QRTypeSchema.safeParse('calendar').success).toBe(false);
      expect(QRTypeSchema.safeParse('URL').success).toBe(false);
    });
  });

  describe('UrlPayloadSchema', () => {
    it('accepts any scheme-bearing URI', () => {
      for (const url of [
        'https://example.com',
        'mailto:hello@example.com',
        'tel:+6512345678',
        'sms:+6512345678',
        'geo:1.28,103.85',
        'bitcoin:bc1qexample',
      ]) {
        expect(UrlPayloadSchema.safeParse({ url }).success).toBe(true);
      }
    });

    it('rejects scheme-less and malformed values', () => {
      expect(UrlPayloadSchema.safeParse({ url: 'example.com/path' }).success).toBe(false);
      expect(UrlPayloadSchema.safeParse({ url: '//example.com' }).success).toBe(false);
      expect(UrlPayloadSchema.safeParse({ url: '1http://x' }).success).toBe(false);
      expect(UrlPayloadSchema.safeParse({ url: '' }).success).toBe(false);
    });

    it('enforces the 1024-char cap', () => {
      expect(UrlPayloadSchema.safeParse({ url: `https://x/${'a'.repeat(1014)}` }).success).toBe(
        true,
      );
      expect(UrlPayloadSchema.safeParse({ url: `https://x/${'a'.repeat(1015)}` }).success).toBe(
        false,
      );
    });
  });

  describe('TextPayloadSchema', () => {
    it('accepts 1..800 chars and rejects outside the bounds', () => {
      expect(TextPayloadSchema.safeParse({ text: 'hello' }).success).toBe(true);
      expect(TextPayloadSchema.safeParse({ text: 'a'.repeat(800) }).success).toBe(true);
      expect(TextPayloadSchema.safeParse({ text: '' }).success).toBe(false);
      expect(TextPayloadSchema.safeParse({ text: 'a'.repeat(801) }).success).toBe(false);
    });
  });

  describe('WifiPayloadSchema', () => {
    it('applies auth + hidden defaults', () => {
      const result = WifiPayloadSchema.safeParse({ ssid: 'Office', password: 'secret' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth).toBe('WPA');
        expect(result.data.hidden).toBe(false);
      }
    });

    it('requires a password unless auth is nopass', () => {
      expect(WifiPayloadSchema.safeParse({ ssid: 'Office' }).success).toBe(false);
      expect(WifiPayloadSchema.safeParse({ ssid: 'Office', auth: 'WEP' }).success).toBe(false);
      expect(WifiPayloadSchema.safeParse({ ssid: 'Office', auth: 'nopass' }).success).toBe(true);
    });

    it('enforces ssid and password caps', () => {
      expect(WifiPayloadSchema.safeParse({ ssid: '', password: 'p' }).success).toBe(false);
      expect(WifiPayloadSchema.safeParse({ ssid: 's'.repeat(65), password: 'p' }).success).toBe(
        false,
      );
      expect(
        WifiPayloadSchema.safeParse({ ssid: 'Office', password: 'p'.repeat(129) }).success,
      ).toBe(false);
    });

    it('rejects unknown auth values (WPA3 is deliberately NOT a token — T:WPA covers it)', () => {
      expect(
        WifiPayloadSchema.safeParse({ ssid: 'Office', auth: 'WPA3', password: 'p' }).success,
      ).toBe(false);
      expect(
        WifiPayloadSchema.safeParse({ ssid: 'Office', auth: 'SAE', password: 'p' }).success,
      ).toBe(false);
    });

    // v1.58.0 — enterprise (WPA2-EAP) refinements.

    it('WPA2-EAP requires eapMethod + identity', () => {
      expect(
        WifiPayloadSchema.safeParse({ ssid: 'Corp', auth: 'WPA2-EAP', password: 'p' }).success,
      ).toBe(false);
      expect(
        WifiPayloadSchema.safeParse({
          ssid: 'Corp',
          auth: 'WPA2-EAP',
          eapMethod: 'PEAP',
          password: 'p',
        }).success,
      ).toBe(false);
      expect(
        WifiPayloadSchema.safeParse({
          ssid: 'Corp',
          auth: 'WPA2-EAP',
          eapMethod: 'PEAP',
          phase2: 'MSCHAPV2',
          identity: 'user@example.com',
          password: 'p',
        }).success,
      ).toBe(true);
    });

    it('WPA2-EAP password is required for PEAP/TTLS/PWD but optional for TLS (cert-based)', () => {
      expect(
        WifiPayloadSchema.safeParse({
          ssid: 'Corp',
          auth: 'WPA2-EAP',
          eapMethod: 'PEAP',
          identity: 'user@example.com',
        }).success,
      ).toBe(false);
      expect(
        WifiPayloadSchema.safeParse({
          ssid: 'Corp',
          auth: 'WPA2-EAP',
          eapMethod: 'TLS',
          identity: 'device01',
        }).success,
      ).toBe(true);
    });

    it('enterprise-only fields are rejected on personal/open auth (no silent identity drop)', () => {
      expect(
        WifiPayloadSchema.safeParse({
          ssid: 'Office',
          auth: 'WPA',
          password: 'p',
          identity: 'user@example.com',
        }).success,
      ).toBe(false);
      expect(
        WifiPayloadSchema.safeParse({
          ssid: 'Open',
          auth: 'nopass',
          eapMethod: 'PEAP',
        }).success,
      ).toBe(false);
    });

    it('existing personal payload shapes parse unchanged (back-compat lock)', () => {
      const legacy = WifiPayloadSchema.safeParse({
        ssid: 'Office',
        auth: 'WPA',
        password: 'secret',
        hidden: true,
      });
      expect(legacy.success).toBe(true);
      if (legacy.success) {
        expect(legacy.data).toEqual({
          ssid: 'Office',
          auth: 'WPA',
          password: 'secret',
          hidden: true,
        });
      }
    });
  });

  describe('VcardPayloadSchema', () => {
    it('requires name; all other fields optional', () => {
      expect(VcardPayloadSchema.safeParse({ name: 'Ada Lovelace' }).success).toBe(true);
      expect(VcardPayloadSchema.safeParse({}).success).toBe(false);
      expect(VcardPayloadSchema.safeParse({ name: '' }).success).toBe(false);
    });

    it('enforces the 128-char cap on every field', () => {
      expect(VcardPayloadSchema.safeParse({ name: 'n'.repeat(129) }).success).toBe(false);
      expect(VcardPayloadSchema.safeParse({ name: 'x', phone: 'p'.repeat(129) }).success).toBe(
        false,
      );
      expect(
        VcardPayloadSchema.safeParse({
          name: 'Ada',
          phone: '+65 1234 5678',
          email: 'user@example.com',
          org: 'Example Co',
          title: 'CEO',
          url: 'https://example.com',
        }).success,
      ).toBe(true);
    });
  });

  describe('QRDesignSchema', () => {
    it('parses {} to the canonical defaults', () => {
      expect(QRDesignSchema.parse({})).toEqual({
        fg: '#000000',
        bg: '#ffffff',
        size: 512,
        margin: 4,
        errorCorrection: 'M',
      });
    });

    it('rejects non-6-digit-hex colors', () => {
      expect(QRDesignSchema.safeParse({ fg: '#fff' }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ fg: 'red' }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ bg: '#GGGGGG' }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ fg: '#AbCdEf' }).success).toBe(true);
    });

    it('bounds size and margin as integers', () => {
      expect(QRDesignSchema.safeParse({ size: 127 }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ size: 2049 }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ size: 512.5 }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ margin: -1 }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ margin: 17 }).success).toBe(false);
      expect(QRDesignSchema.safeParse({ size: 128, margin: 0 }).success).toBe(true);
      expect(QRDesignSchema.safeParse({ size: 2048, margin: 16 }).success).toBe(true);
    });

    it('rejects unknown error-correction levels', () => {
      expect(QRDesignSchema.safeParse({ errorCorrection: 'X' }).success).toBe(false);
    });

    it('accepts only png/jpeg/svg+xml base64 data URIs for the logo', () => {
      expect(QRDesignSchema.safeParse({ logoDataUri: logoDataUri(64) }).success).toBe(true);
      expect(QRDesignSchema.safeParse({ logoDataUri: logoDataUri(64, 'image/jpeg') }).success).toBe(
        true,
      );
      expect(
        QRDesignSchema.safeParse({ logoDataUri: logoDataUri(64, 'image/svg+xml') }).success,
      ).toBe(true);
      expect(QRDesignSchema.safeParse({ logoDataUri: logoDataUri(64, 'image/gif') }).success).toBe(
        false,
      );
      expect(
        QRDesignSchema.safeParse({ logoDataUri: 'https://example.com/logo.png' }).success,
      ).toBe(false);
    });

    it('enforces the 100 KB decoded logo cap at the exact boundary', () => {
      expect(
        QRDesignSchema.safeParse({ logoDataUri: logoDataUri(QR_LOGO_MAX_BYTES) }).success,
      ).toBe(true);
      expect(
        QRDesignSchema.safeParse({ logoDataUri: logoDataUri(QR_LOGO_MAX_BYTES + 1) }).success,
      ).toBe(false);
    });
  });

  describe('QRCodeSchema', () => {
    const base = {
      id: 'abc123',
      domain: 'links.example.com',
      design: QRDesignSchema.parse({}),
      createdAt: 1000,
      updatedAt: 1000,
      createdBy: 'user@example.com',
    };

    it('accepts a valid record of each type', () => {
      expect(
        QRCodeSchema.safeParse({
          ...base,
          type: 'url',
          payload: { url: 'https://target.example.com' },
        }).success,
      ).toBe(true);
      expect(
        QRCodeSchema.safeParse({ ...base, type: 'text', payload: { text: 'hi' } }).success,
      ).toBe(true);
      expect(
        QRCodeSchema.safeParse({
          ...base,
          type: 'wifi',
          payload: { ssid: 'Office', auth: 'WPA', password: 'p', hidden: false },
        }).success,
      ).toBe(true);
      expect(
        QRCodeSchema.safeParse({ ...base, type: 'vcard', payload: { name: 'Ada' } }).success,
      ).toBe(true);
    });

    it('rejects a payload that does not match the declared type', () => {
      expect(
        QRCodeSchema.safeParse({
          ...base,
          type: 'text',
          payload: { url: 'https://target.example.com' },
        }).success,
      ).toBe(false);
      expect(
        QRCodeSchema.safeParse({ ...base, type: 'url', payload: { text: 'hi' } }).success,
      ).toBe(false);
    });

    it('allows linkedRoute only on url-type records', () => {
      const linkedRoute = { domain: 'links.example.com', path: '/github' };
      expect(
        QRCodeSchema.safeParse({
          ...base,
          type: 'url',
          payload: { url: 'https://target.example.com' },
          linkedRoute,
        }).success,
      ).toBe(true);
      expect(
        QRCodeSchema.safeParse({ ...base, type: 'text', payload: { text: 'hi' }, linkedRoute })
          .success,
      ).toBe(false);
      expect(
        QRCodeSchema.safeParse({ ...base, type: 'vcard', payload: { name: 'H' }, linkedRoute })
          .success,
      ).toBe(false);
    });

    it('enforces description and tags caps', () => {
      const url = { ...base, type: 'url', payload: { url: 'https://target.example.com' } };
      expect(QRCodeSchema.safeParse({ ...url, description: 'l'.repeat(100) }).success).toBe(true);
      expect(QRCodeSchema.safeParse({ ...url, description: 'l'.repeat(101) }).success).toBe(false);
      expect(QRCodeSchema.safeParse({ ...url, tags: Array(10).fill('t') }).success).toBe(true);
      expect(QRCodeSchema.safeParse({ ...url, tags: Array(11).fill('t') }).success).toBe(false);
      expect(QRCodeSchema.safeParse({ ...url, tags: ['t'.repeat(31)] }).success).toBe(false);
    });
  });

  describe('CreateQRInputSchema', () => {
    it('accepts a minimal variant of each type', () => {
      expect(
        CreateQRInputSchema.safeParse({
          type: 'url',
          payload: { url: 'https://target.example.com' },
        }).success,
      ).toBe(true);
      expect(CreateQRInputSchema.safeParse({ type: 'text', payload: { text: 'hi' } }).success).toBe(
        true,
      );
      expect(
        CreateQRInputSchema.safeParse({ type: 'vcard', payload: { name: 'Ada' } }).success,
      ).toBe(true);
      expect(
        CreateQRInputSchema.safeParse({ type: 'wifi', payload: { ssid: 'Office', password: 'p' } })
          .success,
      ).toBe(true);
    });

    it('rejects an unknown type and a mismatched payload', () => {
      expect(
        CreateQRInputSchema.safeParse({ type: 'calendar', payload: { text: 'x' } }).success,
      ).toBe(false);
      expect(CreateQRInputSchema.safeParse({ type: 'url', payload: { text: 'hi' } }).success).toBe(
        false,
      );
    });

    it('enforces the wifi password requirement through the union', () => {
      expect(
        CreateQRInputSchema.safeParse({ type: 'wifi', payload: { ssid: 'Office' } }).success,
      ).toBe(false);
      expect(
        CreateQRInputSchema.safeParse({ type: 'wifi', payload: { ssid: 'Office', auth: 'nopass' } })
          .success,
      ).toBe(true);
    });

    it('validates the custom id slug against QR_ID_REGEX bounds', () => {
      const valid = { type: 'text', payload: { text: 'hi' } };
      expect(CreateQRInputSchema.safeParse({ ...valid, id: 'abc' }).success).toBe(true);
      expect(CreateQRInputSchema.safeParse({ ...valid, id: 'my-qr-1' }).success).toBe(true);
      expect(CreateQRInputSchema.safeParse({ ...valid, id: `a${'b'.repeat(31)}` }).success).toBe(
        true,
      );
      expect(CreateQRInputSchema.safeParse({ ...valid, id: 'ab' }).success).toBe(false);
      expect(CreateQRInputSchema.safeParse({ ...valid, id: `a${'b'.repeat(32)}` }).success).toBe(
        false,
      );
      expect(CreateQRInputSchema.safeParse({ ...valid, id: 'Abc' }).success).toBe(false);
      expect(CreateQRInputSchema.safeParse({ ...valid, id: '-abc' }).success).toBe(false);
      expect(CreateQRInputSchema.safeParse({ ...valid, id: 'a_bc' }).success).toBe(false);
    });

    it('carries linkedRoute on the url variant', () => {
      const result = CreateQRInputSchema.safeParse({
        type: 'url',
        payload: { url: 'https://target.example.com' },
        linkedRoute: { domain: 'links.example.com', path: '/github' },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.type === 'url') {
        expect(result.data.linkedRoute).toEqual({ domain: 'links.example.com', path: '/github' });
      }
    });

    it('applies design sub-defaults when design is partially provided', () => {
      const result = CreateQRInputSchema.safeParse({
        type: 'text',
        payload: { text: 'hi' },
        design: { fg: '#ff0000' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.design).toEqual({
          fg: '#ff0000',
          bg: '#ffffff',
          size: 512,
          margin: 4,
          errorCorrection: 'M',
        });
      }
    });
  });

  describe('UpdateQRInputSchema', () => {
    it('accepts an empty patch and injects NO defaults (omitted = unchanged)', () => {
      const result = UpdateQRInputSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });

    it('accepts single-field patches', () => {
      expect(UpdateQRInputSchema.safeParse({ description: 'New description' }).success).toBe(true);
      expect(UpdateQRInputSchema.safeParse({ tags: ['a', 'b'] }).success).toBe(true);
      expect(UpdateQRInputSchema.safeParse({ payload: { text: 'hi' } }).success).toBe(true);
      expect(UpdateQRInputSchema.safeParse({ design: { fg: '#ff0000' } }).success).toBe(true);
    });

    it('accepts linkedRoute: null to clear the link', () => {
      const result = UpdateQRInputSchema.safeParse({ linkedRoute: null });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.linkedRoute).toBeNull();
      }
    });

    it('accepts any record-shaped payload at the wire (handler validates per type)', () => {
      // v1.54.1: the wire schema is transport-loose — the strict union was
      // first-match-wins with key-stripping, which made vcards carrying a
      // scheme-bearing website `url` uneditable. Per-type validation is the
      // handler's job (QR_PAYLOAD_SCHEMAS[existing.type]); integration tests
      // cover the rejection path.
      expect(UpdateQRInputSchema.safeParse({ payload: { url: 'no-scheme' } }).success).toBe(true);
      expect(
        UpdateQRInputSchema.safeParse({
          payload: { name: 'Alice', url: 'https://alice.example.com' },
        }).success,
      ).toBe(true);
      expect(UpdateQRInputSchema.safeParse({ payload: 'not-an-object' }).success).toBe(false);
    });

    it('strict payload schemas reject unknown keys instead of stripping them', () => {
      expect(
        UrlPayloadSchema.safeParse({ url: 'https://target.example.com', name: 'stray' }).success,
      ).toBe(false);
      expect(
        VcardPayloadSchema.safeParse({ name: 'Alice', url: 'https://alice.example.com' }).success,
      ).toBe(true);
    });
  });

  describe('QRListQuerySchema', () => {
    it('coerces string offset/limit and defaults offset to 0', () => {
      const result = QRListQuerySchema.safeParse({ offset: '5', limit: '10' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset).toBe(5);
        expect(result.data.limit).toBe(10);
      }
      const defaults = QRListQuerySchema.parse({});
      expect(defaults.offset).toBe(0);
      expect(defaults.limit).toBeUndefined();
    });

    it('bounds limit and rejects invalid type filters', () => {
      expect(QRListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
      expect(QRListQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
      expect(QRListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
      expect(QRListQuerySchema.safeParse({ type: 'wifi' }).success).toBe(true);
      expect(QRListQuerySchema.safeParse({ type: 'calendar' }).success).toBe(false);
    });
  });

  describe('escapeMecard', () => {
    it('escapes backslash, semicolon, comma, colon, and double-quote', () => {
      expect(escapeMecard('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f');
    });

    it('leaves plain text untouched', () => {
      expect(escapeMecard('Ada Lovelace +65')).toBe('Ada Lovelace +65');
    });
  });

  describe('serializePayload', () => {
    it('returns url and text verbatim (no escaping)', () => {
      expect(serializePayload('url', { url: 'https://x/?a=1;b=2' })).toBe('https://x/?a=1;b=2');
      expect(serializePayload('text', { text: 'plain; text: here' })).toBe('plain; text: here');
    });

    it('serializes wifi with escaping, and omits P: when nopass and H: when not hidden', () => {
      expect(
        serializePayload('wifi', {
          ssid: 'Guest;Net:2,4',
          auth: 'WPA',
          password: 'p,w:d',
          hidden: false,
        }),
      ).toBe('WIFI:T:WPA;S:Guest\\;Net\\:2\\,4;P:p\\,w\\:d;;');
      expect(serializePayload('wifi', { ssid: 'Open', auth: 'nopass', hidden: false })).toBe(
        'WIFI:T:nopass;S:Open;;',
      );
      expect(
        serializePayload('wifi', { ssid: 'Cloak', auth: 'WEP', password: 'k', hidden: true }),
      ).toBe('WIFI:T:WEP;S:Cloak;P:k;H:true;;');
    });

    it('serializes enterprise (WPA2-EAP) wifi with the ZXing E:/PH2:/A:/I: fields (v1.58.0)', () => {
      expect(
        serializePayload('wifi', {
          ssid: 'Corp',
          auth: 'WPA2-EAP',
          eapMethod: 'PEAP',
          phase2: 'MSCHAPV2',
          anonymousIdentity: 'anon@example.com',
          identity: 'ada;lovelace@example.com',
          password: 'p:w',
          hidden: false,
        }),
      ).toBe(
        'WIFI:T:WPA2-EAP;S:Corp;E:PEAP;PH2:MSCHAPV2;A:anon@example.com;I:ada\\;lovelace@example.com;P:p\\:w;;',
      );
      // TLS (certificate-based): password omitted entirely when absent.
      expect(
        serializePayload('wifi', {
          ssid: 'CorpTLS',
          auth: 'WPA2-EAP',
          eapMethod: 'TLS',
          identity: 'device01',
          hidden: true,
        }),
      ).toBe('WIFI:T:WPA2-EAP;S:CorpTLS;E:TLS;I:device01;H:true;;');
    });

    it('worst-case enterprise wifi payload stays under MAX_QR_PAYLOAD_LENGTH', () => {
      // Escaping doubles each ';' — maxed identity fields of pure semicolons.
      const serialized = serializePayload('wifi', {
        ssid: ';'.repeat(64),
        auth: 'WPA2-EAP',
        eapMethod: 'PEAP',
        phase2: 'MSCHAPV2',
        anonymousIdentity: ';'.repeat(128),
        identity: ';'.repeat(128),
        password: ';'.repeat(128),
        hidden: true,
      });
      expect(serialized.length).toBeLessThanOrEqual(MAX_QR_PAYLOAD_LENGTH);
    });

    it('serializes vcard as MECARD with optional fields omitted', () => {
      expect(serializePayload('vcard', { name: 'Ada Lovelace' })).toBe('MECARD:N:Ada Lovelace;;');
      expect(
        serializePayload('vcard', {
          name: 'Lovelace; Ada',
          phone: '+6512345678',
          email: 'user@example.com',
          org: 'Example, Ltd',
          title: 'CEO',
          url: 'https://example.com',
        }),
      ).toBe(
        'MECARD:N:Lovelace\\; Ada;TEL:+6512345678;EMAIL:user@example.com;ORG:Example\\, Ltd;TITLE:CEO;URL:https\\://example.com;;',
      );
    });

    it('can exceed MAX_QR_PAYLOAD_LENGTH for a maxed-out vcard (handler guard)', () => {
      // Escaping doubles each ';' — six maxed 128-char fields serialize to ~1.5 KB.
      const serialized = serializePayload('vcard', {
        name: ';'.repeat(128),
        phone: ';'.repeat(128),
        email: ';'.repeat(128),
        org: ';'.repeat(128),
        title: ';'.repeat(128),
        url: ';'.repeat(128),
      });
      expect(MAX_QR_PAYLOAD_LENGTH).toBe(1024);
      expect(serialized.length).toBeGreaterThan(MAX_QR_PAYLOAD_LENGTH);
    });
  });

  describe('generateQrId', () => {
    it('produces 12-char lowercase hex ids matching QR_ID_REGEX', () => {
      for (let i = 0; i < 20; i++) {
        const id = generateQrId();
        expect(id).toMatch(/^[0-9a-f]{12}$/);
        expect(id).toMatch(QR_ID_REGEX);
      }
    });

    it('produces distinct ids across calls', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateQrId()));
      expect(ids.size).toBe(50);
    });
  });

  describe('normalizeQrId (v1.58.5)', () => {
    it('lowercases and kebab-cases free text', () => {
      expect(normalizeQrId('Office WiFi')).toBe('office-wifi');
      expect(normalizeQrId('KL Office — Guest Network')).toBe('kl-office-guest-network');
      expect(normalizeQrId('already-fine')).toBe('already-fine');
    });

    it('collapses runs and trims leading/trailing separators', () => {
      // The regex demands an alphanumeric FIRST char and no trailing hyphen,
      // so both ends must be stripped — not just collapsed.
      expect(normalizeQrId('  --Hello!!  ')).toBe('hello');
      expect(normalizeQrId('a///b___c')).toBe('a-b-c');
      expect(normalizeQrId('-leading')).toBe('leading');
      expect(normalizeQrId('trailing-')).toBe('trailing');
    });

    it('caps at the 32-char ceiling without leaving a trailing hyphen', () => {
      const out = normalizeQrId('a'.repeat(40));
      expect(out).toHaveLength(32);
      // Truncation can land mid-separator; the trailing trim runs after it.
      const cut = normalizeQrId(`${'b'.repeat(31)} tail`);
      expect(cut.endsWith('-')).toBe(false);
      expect(cut.length).toBeLessThanOrEqual(32);
    });

    it('output always satisfies QR_ID_REGEX once it clears the 3-char floor', () => {
      const samples = [
        'Office WiFi',
        'KL Office — Guest Network',
        '  --Hello!!  ',
        'a///b___c',
        'MiXeD CaSe 123',
        'x'.repeat(40),
        'Ærø & Co.',
      ];
      for (const sample of samples) {
        const out = normalizeQrId(sample);
        // Every sample here carries enough alphanumerics to clear the floor,
        // asserted rather than assumed so the regex check can't pass vacuously.
        expect(out.length).toBeGreaterThanOrEqual(3);
        expect(out).toMatch(QR_ID_REGEX);
      }
    });

    it('returns empty for input with nothing usable, rather than inventing an id', () => {
      expect(normalizeQrId('')).toBe('');
      expect(normalizeQrId('!!!')).toBe('');
      expect(normalizeQrId('   ')).toBe('');
    });

    it('is idempotent — re-normalising a normalised id is a no-op', () => {
      for (const sample of ['Office WiFi', '  --Hello!!  ', 'x'.repeat(40)]) {
        const once = normalizeQrId(sample);
        expect(normalizeQrId(once)).toBe(once);
      }
    });
  });
});

describe('logoDataUri attribute-breakout hardening', () => {
  const base = { fg: '#000000', bg: '#ffffff', size: 512, margin: 4, errorCorrection: 'H' };

  it('rejects data URIs whose body contains quote characters', () => {
    const crafted = `data:image/png;base64,AAAA" onload="alert(1)`;
    expect(QRDesignSchema.safeParse({ ...base, logoDataUri: crafted }).success).toBe(false);
  });

  it('rejects data URIs with angle brackets or spaces in the body', () => {
    expect(
      QRDesignSchema.safeParse({ ...base, logoDataUri: 'data:image/png;base64,<svg>' }).success,
    ).toBe(false);
    expect(
      QRDesignSchema.safeParse({ ...base, logoDataUri: 'data:image/png;base64,AA AA' }).success,
    ).toBe(false);
  });

  it('accepts a well-formed padded base64 body', () => {
    expect(
      QRDesignSchema.safeParse({ ...base, logoDataUri: 'data:image/png;base64,iVBORw0KGgo=' })
        .success,
    ).toBe(true);
  });

  describe('normalizeQrIdInput (v1.58.8 — typing-friendly controlled-input variant)', () => {
    it('preserves a trailing hyphen while typing (the controlled-input hyphen-eating fix)', () => {
      // Keystroke sequence 'office' -> '-' -> 'w': the input normaliser must
      // keep the trailing hyphen so the next character lands after it.
      expect(normalizeQrIdInput('office-')).toBe('office-');
      expect(normalizeQrIdInput('office-w')).toBe('office-w');
    });

    it('still collapses separator runs, strips leading separators, lowercases, and caps', () => {
      expect(normalizeQrIdInput('office--')).toBe('office-');
      expect(normalizeQrIdInput('-office')).toBe('office');
      expect(normalizeQrIdInput('Office WiFi ')).toBe('office-wifi-');
      expect(normalizeQrIdInput('x'.repeat(40)).length).toBe(32);
    });

    it('normalizeQrId is exactly the input variant plus the trailing trim', () => {
      for (const raw of ['office-', 'Office WiFi ', '-a-', 'a--b--', 'x'.repeat(40)]) {
        expect(normalizeQrId(raw)).toBe(normalizeQrIdInput(raw).replace(/-+$/, ''));
      }
    });
  });
});
