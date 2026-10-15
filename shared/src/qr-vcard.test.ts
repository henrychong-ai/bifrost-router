/**
 * Contact cards as vCard 3.0 (v1.42.0): the serializer, the write and stored
 * payload rules, and the name helpers.
 *
 * The golden vectors are the bytes a reference vCard 3.0 generator, whose
 * structure was tested on phones (iPhone camera, Android, and other common
 * scanners), writes for the same invented cards: CRLF, no folding, nothing
 * after END:VCARD, lines N, FN, ORG, TITLE, TEL…, EMAIL, URL, ADR.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeVcardText,
  MAX_QR_PAYLOAD_LENGTH,
  parseStoredQR,
  QRDesignSchema,
  type QRVcardPayload,
  STORED_QR_PAYLOAD_SCHEMAS,
  StoredVcardPayloadSchema,
  serializeVcard,
  VCARD_ADDRESS_PARTS,
  VcardPayloadSchema,
  withoutControlCharacters,
} from './qr.js';
import { isFilled, vcardFullName, vcardGivenAndSurname, vcardHasName } from './vcard-name.js';

/** The N and FN lines of a card. */
const nameLines = (card: QRVcardPayload) =>
  serializeVcard(card)
    .split('\r\n')
    .filter(line => line.startsWith('N:') || line.startsWith('FN:'));

/** The URL line of a card with only a first name and `url`. */
const urlLine = (url: string) =>
  serializeVcard({ firstName: 'A', url })
    .split('\r\n')
    .find(line => line.startsWith('URL:'));

/** The TEL lines of a card. */
const tels = (card: QRVcardPayload) =>
  serializeVcard(card)
    .split('\r\n')
    .filter(line => line.startsWith('TEL'));

/** A stored contact-card record holding `payload`. */
const record = (payload: Record<string, unknown>) => ({
  id: 'card',
  domain: 'example.com',
  type: 'vcard',
  payload,
  design: QRDesignSchema.parse({}),
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'test',
});

/** The vCard a stored record holding `payload` encodes, once read back. */
const encode = (payload: Record<string, unknown>) => {
  const parsed = parseStoredQR(record(payload));
  expect(parsed).not.toBeNull();
  return serializeVcard(parsed?.payload as QRVcardPayload);
};

const FULL_CARD: QRVcardPayload = {
  firstName: 'Jane',
  surname: 'Doe',
  org: 'Example Widgets, Inc.',
  title: 'Head of Operations; Asia',
  phones: [
    { number: '+1 555 0100', type: 'work' },
    { number: '+1 555 0199', type: 'main' },
  ],
  email: 'jane.doe@example.com',
  url: 'example.com',
  address: {
    street: 'Suite 12, 100 Main Street',
    city: 'Springfield',
    region: 'Example State',
    postcode: '12345',
    country: 'Exampleland',
  },
};

describe('serializeVcard golden vectors', () => {
  it('a full card: every line, escaped text, unescaped TEL, EMAIL and website', () => {
    expect(serializeVcard(FULL_CARD)).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nORG:Example Widgets\\, Inc.\r\nTITLE:Head of Operations\\; Asia\r\nTEL;TYPE=WORK,VOICE,PREF:+1 555 0100\r\nTEL;TYPE=WORK,MAIN:+1 555 0199\r\nEMAIL;TYPE=INTERNET,WORK:jane.doe@example.com\r\nURL:https://example.com\r\nADR;TYPE=WORK:;;Suite 12\\, 100 Main Street;Springfield;Example State;12345;Exampleland\r\nEND:VCARD',
    );
  });

  it('a minimal card: name, company and email only', () => {
    expect(
      serializeVcard({
        firstName: 'Richard',
        surname: 'Roe',
        org: 'Example Org',
        email: 'richard.roe@example.org',
      }),
    ).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Roe;Richard;;;\r\nFN:Richard Roe\r\nORG:Example Org\r\nEMAIL;TYPE=INTERNET,WORK:richard.roe@example.org\r\nEND:VCARD',
    );
  });

  it('an office line only, a backslash in the company, a full website, a country only', () => {
    expect(
      serializeVcard({
        firstName: 'John',
        surname: 'Doe',
        org: 'Back\\slash Ltd',
        phones: [{ number: '+44 20 7946 0000', type: 'main' }],
        url: 'https://www.example.net/team/john',
        address: { country: 'Exampleland' },
      }),
    ).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;John;;;\r\nFN:John Doe\r\nORG:Back\\\\slash Ltd\r\nTEL;TYPE=WORK,MAIN:+44 20 7946 0000\r\nURL:https://www.example.net/team/john\r\nADR;TYPE=WORK:;;;;;;Exampleland\r\nEND:VCARD',
    );
  });
});

describe('serializeVcard', () => {
  it('ends every line with CRLF, never a bare LF, and nothing after END:VCARD', () => {
    const text = serializeVcard({ firstName: 'Jane', surname: 'Doe', title: 'A\nB\r\nC\rD' });
    expect(text.split('\r\n')).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Doe;Jane;;;',
      'FN:Jane Doe',
      'TITLE:A\\nB\\nC\\nD',
      'END:VCARD',
    ]);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(text.endsWith('END:VCARD')).toBe(true);
  });

  it('escapes text values (backslash, semicolon, comma, line break), never the website, TEL, or EMAIL', () => {
    expect(escapeVcardText('a\\b;c,d:e"f\ng')).toBe('a\\\\b\\;c\\,d:e"f\\ng');
    const text = serializeVcard({
      firstName: 'A;B',
      surname: 'C,D',
      displayName: 'E\\F',
      org: 'G, H; I',
      email: 'j,k@example.com',
      url: 'https://example.com/a,b;c?x=1&y=2',
      phones: [{ number: '+1 555;0100', type: 'cell' }],
    });
    expect(text).toContain('\r\nN:C\\,D;A\\;B;;;\r\n');
    expect(text).toContain('\r\nFN:E\\\\F\r\n');
    expect(text).toContain('\r\nORG:G\\, H\\; I\r\n');
    expect(text).toContain('\r\nTEL;TYPE=CELL:+1 555;0100\r\n');
    expect(text).toContain('\r\nEMAIL;TYPE=INTERNET,WORK:j,k@example.com\r\n');
    // No backslash in the website: phones open it as a link
    expect(text).toContain('\r\nURL:https://example.com/a,b;c?x=1&y=2\r\n');
  });

  it('maps the legacy name to FN and the given part of N, and the legacy phone to WORK,VOICE', () => {
    expect(
      serializeVcard({
        name: 'Jane Doe',
        phone: '+1 555 0100',
        email: 'jane@example.com',
        org: 'Example',
        title: 'CEO',
        url: 'https://example.com',
      }),
    ).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane Doe;;;\r\nFN:Jane Doe\r\nORG:Example\r\nTITLE:CEO\r\nTEL;TYPE=WORK,VOICE:+1 555 0100\r\nEMAIL;TYPE=INTERNET,WORK:jane@example.com\r\nURL:https://example.com\r\nEND:VCARD',
    );
    // A legacy record stored with an empty phone
    expect(serializeVcard({ name: 'A', phone: '' })).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;A;;;\r\nFN:A\r\nEND:VCARD',
    );
    // A stored legacy card whose name is blank encodes an empty N and FN
    expect(serializeVcard({ name: ' ' })).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;;;;\r\nFN:\r\nEND:VCARD',
    );
  });

  it('encodes a UTF-8 name as UTF-8 text, unescaped', () => {
    const text = serializeVcard({ firstName: 'José', surname: 'Müller-Ñúñez' });
    expect(text).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Müller-Ñúñez;José;;;\r\nFN:José Müller-Ñúñez\r\nEND:VCARD',
    );
    expect(new TextEncoder().encode(text).length).toBe(text.length + 10);
  });

  it('builds N and FN from whichever name fields are given', () => {
    expect(nameLines({ surname: 'Doe' })).toEqual(['N:Doe;;;;', 'FN:Doe']);
    expect(nameLines({ displayName: 'Dr Jane Doe' })).toEqual([
      'N:;Dr Jane Doe;;;',
      'FN:Dr Jane Doe',
    ]);
    expect(nameLines({ firstName: 'Jane', surname: 'Doe', displayName: 'Dr Jane Doe' })).toEqual([
      'N:Doe;Jane;;;',
      'FN:Dr Jane Doe',
    ]);
    expect(nameLines({ surname: 'Doe', displayName: 'Dr Doe' })).toEqual([
      'N:Doe;;;;',
      'FN:Dr Doe',
    ]);
    // Values are trimmed
    expect(nameLines({ firstName: '  Jane ', surname: ' Doe  ' })).toEqual([
      'N:Doe;Jane;;;',
      'FN:Jane Doe',
    ]);
  });

  it('writes each phone type, PREF on the first work number only, in the order given', () => {
    expect(
      tels({
        firstName: 'Jane',
        phones: [
          { number: '+1 555 0101', type: 'fax' },
          { number: '+1 555 0102', type: 'work' },
          { number: '+1 555 0103', type: 'work' },
        ],
      }),
    ).toEqual([
      'TEL;TYPE=WORK,FAX:+1 555 0101',
      'TEL;TYPE=WORK,VOICE,PREF:+1 555 0102',
      'TEL;TYPE=WORK,VOICE:+1 555 0103',
    ]);
    // A blank stored number is left out
    expect(
      tels({
        firstName: 'Jane',
        phones: [
          { number: '+1 555 0104', type: 'cell' },
          { number: ' ', type: 'work' },
          { number: '+1 555 0105', type: 'main' },
        ],
      }),
    ).toEqual(['TEL;TYPE=CELL:+1 555 0104', 'TEL;TYPE=WORK,MAIN:+1 555 0105']);
  });

  it('adds https:// to a website without a scheme and drops control characters', () => {
    expect(urlLine('example.com')).toBe('URL:https://example.com');
    expect(urlLine(' www.example.com/team ')).toBe('URL:https://www.example.com/team');
    expect(urlLine('http://example.com')).toBe('URL:http://example.com');
    expect(urlLine('HTTPS://example.com')).toBe('URL:HTTPS://example.com');
    // A stored website from an earlier release can hold a line break: it never ends the line
    expect(urlLine('https://a.example\r\nX-EVIL:1')).toBe('URL:https://a.exampleX-EVIL:1');
    expect(urlLine('   ')).toBeUndefined();
    // Control characters go first, then the trim, then the scheme test
    expect(urlLine('\u0001 example.com')).toBe('URL:https://example.com');
    expect(urlLine('example.com \u0007')).toBe('URL:https://example.com');
  });

  it('writes the address parts in VCARD_ADDRESS_PARTS order', () => {
    expect(VCARD_ADDRESS_PARTS).toEqual(['street', 'city', 'region', 'postcode', 'country']);
    const address = Object.fromEntries(VCARD_ADDRESS_PARTS.map(part => [part, part]));
    expect(serializeVcard({ firstName: 'Jane', address })).toContain(
      '\r\nADR;TYPE=WORK:;;street;city;region;postcode;country\r\n',
    );
  });

  it('writes the address only when a part is filled, every part escaped', () => {
    expect(serializeVcard({ firstName: 'Jane', address: { city: ' ' } })).not.toContain('ADR');
    expect(
      serializeVcard({ firstName: 'Jane', address: { region: 'North; East', postcode: '12345' } }),
    ).toContain('\r\nADR;TYPE=WORK:;;;;North\\; East;12345;\r\n');
  });

  it('leaves out blank optional fields', () => {
    expect(
      serializeVcard({ firstName: 'Jane', org: ' ', title: '', email: ' ', url: '', phones: [] }),
    ).toBe('BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane;;;\r\nFN:Jane\r\nEND:VCARD');
  });

  it('a typical full card stays under the payload guard, counted in UTF-8 bytes', () => {
    expect(new TextEncoder().encode(serializeVcard(FULL_CARD)).length).toBeLessThan(
      MAX_QR_PAYLOAD_LENGTH,
    );
  });
});

describe('withoutControlCharacters', () => {
  it('drops C0 controls and DEL, keeps everything else', () => {
    expect(withoutControlCharacters('a\u0000b\tc\r\nd\u007fé ')).toBe('abcdé ');
  });

  it('with keepLineBreaks keeps CR and LF only', () => {
    expect(withoutControlCharacters('a\u0000b\tc\r\nd\u007f', { keepLineBreaks: true })).toBe(
      'abc\r\nd',
    );
  });
});

describe('control characters in contact-card text', () => {
  it('a write refuses them in every text field, line breaks excepted', () => {
    const fields: Array<[Record<string, unknown>, Array<string | number>]> = [
      [{ firstName: 'A\u000bB' }, ['firstName']],
      [{ firstName: 'A', surname: 'A\u0000B' }, ['surname']],
      [{ firstName: 'A', displayName: 'A\tB' }, ['displayName']],
      [{ name: 'A\u007fB' }, ['name']],
      [{ firstName: 'A', org: 'A\u001fB' }, ['org']],
      [{ firstName: 'A', title: 'A\u0001' }, ['title']],
      [{ name: 'A', phone: '+1\u0002555' }, ['phone']],
      [{ firstName: 'A', email: 'a\u0000@example.com' }, ['email']],
      [
        { firstName: 'A', phones: [{ number: '+1\u000b555', type: 'work' }] },
        ['phones', 0, 'number'],
      ],
      [{ firstName: 'A', address: { city: 'K\u0000L' } }, ['address', 'city']],
    ];
    for (const [payload, path] of fields) {
      const result = VcardPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map(issue => issue.path)).toContainEqual(path);
    }
    expect(VcardPayloadSchema.safeParse({ firstName: 'A', title: 'A\r\nB\nC' }).success).toBe(true);
  });

  it('a write refuses a line break in a phone number, the legacy phone, or email', () => {
    for (const [payload, path] of [
      [{ firstName: 'A', phones: [{ number: '+1\n555', type: 'work' }] }, ['phones', 0, 'number']],
      [{ name: 'A', phone: '+1\r555' }, ['phone']],
      [{ firstName: 'A', email: 'a@example.com\n' }, ['email']],
    ] as const) {
      const result = VcardPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map(issue => issue.path)).toContainEqual(path);
    }
    // Other text keeps its line breaks
    expect(VcardPayloadSchema.safeParse({ firstName: 'A', org: 'B\nC' }).success).toBe(true);
  });

  it('a stored record holding them still reads, and encodes without them', () => {
    expect(StoredVcardPayloadSchema.safeParse({ firstName: 'A\u0000B' }).success).toBe(true);
    expect(STORED_QR_PAYLOAD_SCHEMAS.vcard).toBe(StoredVcardPayloadSchema);
    expect(serializeVcard({ firstName: 'A\u0000B', title: '\u0001x\u007f' })).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;AB;;;\r\nFN:AB\r\nTITLE:x\r\nEND:VCARD',
    );
    // A value that is only control characters is left out
    expect(serializeVcard({ firstName: 'A', org: '\u0001' })).not.toContain('ORG');
    // CR and LF still become \n in text, and are dropped from TEL and EMAIL
    expect(serializeVcard({ firstName: 'A', title: 'B\r\nC\rD\nE' })).toContain(
      '\r\nTITLE:B\\nC\\nD\\nE\r\n',
    );
    const raw = serializeVcard({
      firstName: 'A',
      phones: [{ number: '+1\n555', type: 'cell' }],
      email: 'a@\r\nexample.com',
    });
    expect(raw).toContain('\r\nTEL;TYPE=CELL:+1555\r\n');
    expect(raw).toContain('\r\nEMAIL;TYPE=INTERNET,WORK:a@example.com\r\n');
    expect(serializeVcard({ name: 'A', phone: '+1\r\n555' })).toContain(
      '\r\nTEL;TYPE=WORK,VOICE:+1555\r\n',
    );
  });
});

describe('blank phone numbers', () => {
  it('a write refuses a blank number, never as a legacy-phone conflict', () => {
    const result = VcardPayloadSchema.safeParse({
      firstName: 'A',
      phone: '+1 555 0100',
      phones: [{ number: ' ', type: 'work' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(issue => issue.path)).toEqual([['phones', 0, 'number']]);
  });

  it('refuses each blank number among real ones; a stored one still reads', () => {
    const phones = [
      { number: ' ', type: 'work' },
      { number: ' ', type: 'work' },
      { number: '+1 555 0100', type: 'main' },
    ];
    expect(StoredVcardPayloadSchema.safeParse({ firstName: 'A', phones }).success).toBe(true);
    const write = VcardPayloadSchema.safeParse({ firstName: 'A', phones });
    expect(write.success).toBe(false);
    expect(write.error?.issues.map(issue => issue.path)).toEqual([
      ['phones', 0, 'number'],
      ['phones', 1, 'number'],
    ]);
  });
});

describe('stored contact cards stay readable', () => {
  it('reads a MECARD-era card: a blank legacy name, a website with a line break', () => {
    expect(parseStoredQR(record({ name: ' ' }))).not.toBeNull();
    expect(parseStoredQR(record({ name: 'A', url: 'https://a.example\nB' }))).not.toBeNull();
    // An empty name was never written (min 1), and no name at all is no card
    expect(parseStoredQR(record({ name: '' }))).toBeNull();
    expect(parseStoredQR(record({ org: 'Example' }))).toBeNull();
  });

  it('reads a card over the field and phone caps', () => {
    const phone = { number: '+1 555 0100', type: 'cell' };
    expect(
      parseStoredQR(
        record({ firstName: 'n'.repeat(300), phones: [phone, phone, phone, phone, phone] }),
      ),
    ).not.toBeNull();
  });

  it('drops an unknown key in the address or a phone entry, as at the top level', () => {
    const parsed = parseStoredQR(
      record({
        firstName: 'Jane',
        stray: 1,
        address: { city: 'Springfield', planet: 'Earth' },
        phones: [{ number: '+1 555 0100', type: 'work', ext: '1' }],
      }),
    );
    expect(parsed?.payload).toEqual({
      firstName: 'Jane',
      address: { city: 'Springfield' },
      phones: [{ number: '+1 555 0100', type: 'work' }],
    });
  });

  it('a legacy field beside its filled replacement is unreadable when stored, as on write', () => {
    const name = { firstName: 'Jane', name: 'Jane' };
    const phone = {
      firstName: 'Jane',
      phone: '+1 555 0100',
      phones: [{ number: '+1 555 0199', type: 'work' }],
    };
    for (const payload of [name, phone]) {
      expect(VcardPayloadSchema.safeParse(payload).success).toBe(false);
      expect(StoredVcardPayloadSchema.safeParse(payload).success).toBe(false);
      expect(parseStoredQR(record(payload))).toBeNull();
    }
  });

  it('reads a stored blank phone number, which a write refuses, and leaves it out', () => {
    const blank = { firstName: 'Jane', phones: [{ number: '', type: 'work' }] };
    expect(VcardPayloadSchema.safeParse(blank).success).toBe(false);
    expect(encode(blank)).toBe('BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane;;;\r\nFN:Jane\r\nEND:VCARD');
    // A blank entry is no conflict: the legacy phone beside it reads and is encoded
    const legacy = {
      firstName: 'Jane',
      phone: '+1 555 0100',
      phones: [{ number: '', type: 'work' }],
    };
    expect(VcardPayloadSchema.safeParse(legacy).success).toBe(false);
    expect(encode(legacy)).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane;;;\r\nFN:Jane\r\nTEL;TYPE=WORK,VOICE:+1 555 0100\r\nEND:VCARD',
    );
  });

  it('refuses a phone entry that is not an object or has an unknown type', () => {
    expect(parseStoredQR(record({ firstName: 'A', phones: ['+1 555 0100'] }))).toBeNull();
    expect(
      parseStoredQR(record({ firstName: 'A', phones: [{ number: '1', type: 'home' }] })),
    ).toBeNull();
  });
});

describe('vcard-name', () => {
  it('vcardHasName is a filled first name, surname, or display name, never the legacy name', () => {
    expect(vcardHasName({ surname: 'Doe' })).toBe(true);
    expect(vcardHasName({ displayName: ' x ' })).toBe(true);
    expect(vcardHasName({ firstName: ' ', name: 'Jane' })).toBe(false);
  });

  it('vcardFullName is the display name, else the legacy name, else First Surname, trimmed', () => {
    expect(vcardFullName({ firstName: 'Jane', surname: 'Doe', displayName: ' Dr Doe ' })).toBe(
      'Dr Doe',
    );
    expect(vcardFullName({ name: ' Jane Doe ' })).toBe('Jane Doe');
    expect(vcardFullName({ firstName: ' Jane ', surname: 'Doe', displayName: ' ' })).toBe(
      'Jane Doe',
    );
    expect(vcardFullName({ surname: 'Doe' })).toBe('Doe');
    expect(vcardFullName({ name: ' ' })).toBe('');
    expect(vcardFullName({ firstName: 5, name: null })).toBe('');
    expect(vcardGivenAndSurname({ firstName: 'Jane', surname: ' Doe' })).toBe('Jane Doe');
    expect(isFilled(' a ')).toBe(true);
    expect(isFilled(' ')).toBe(false);
    expect(isFilled(5)).toBe(false);
  });
});
