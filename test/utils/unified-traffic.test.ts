import { describe, expect, it } from 'vitest';
import {
  boundedUnifiedCacheStatus,
  boundedUnifiedCountry,
  boundedUnifiedLatencyMs,
  classifyUnifiedTraffic,
  findCredentialParams,
  isUnifiedTrafficCaptureActive,
  isUnifiedTrafficRequestEligible,
  LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH,
  LEGACY_AMBIGUOUS_MIN_HEX_LENGTH,
  LEGACY_AMBIGUOUS_MIN_MIXED_LENGTH,
  legacyQueryString,
  legacyReferrer,
  parseUnifiedTrafficCutoverAt,
  parseUnifiedTrafficRetentionDays,
  privacySafeUnifiedAnalyticsPath,
  unifiedTrafficOutcome,
} from '../../src/utils/unified-traffic';

describe('unified traffic configuration', () => {
  it('requires shadow mode and an explicit reached RFC3339 cutover', () => {
    expect(isUnifiedTrafficCaptureActive('off', '2026-08-12T00:00:00Z', 1_786_492_800)).toBe(false);
    expect(isUnifiedTrafficCaptureActive('shadow', '', 1_786_492_800)).toBe(false);
    expect(isUnifiedTrafficCaptureActive('shadow', '2026-08-13T00:00:00Z', 1_786_492_800)).toBe(
      false,
    );
    expect(isUnifiedTrafficCaptureActive('shadow', '2026-08-12T00:00:00Z', 1_786_492_800)).toBe(
      true,
    );
  });

  it('fails closed on timezone-free or invalid values', () => {
    expect(parseUnifiedTrafficCutoverAt('2026-08-12T00:00:00')).toBeNull();
    expect(parseUnifiedTrafficCutoverAt('not-a-date')).toBeNull();
    expect(parseUnifiedTrafficRetentionDays('30')).toBe(30);
    expect(parseUnifiedTrafficRetentionDays('0')).toBeNull();
  });
});

describe('unified request eligibility', () => {
  const base = {
    mode: 'shadow',
    cutoverAt: '2026-08-12T00:00:00Z',
    hostname: 'example.com',
    adminHostname: 'bifrost.example.com',
    path: '/docs',
    userAgent: 'Mozilla/5.0',
    nowSeconds: 1_786_492_800,
  };

  it('includes public traffic and excludes operational surfaces', () => {
    expect(isUnifiedTrafficRequestEligible(base)).toBe(true);
    expect(isUnifiedTrafficRequestEligible({ ...base, hostname: 'bifrost.example.com' })).toBe(
      false,
    );
    expect(isUnifiedTrafficRequestEligible({ ...base, path: '/health' })).toBe(false);
    expect(isUnifiedTrafficRequestEligible({ ...base, path: '/api/routes' })).toBe(false);
    expect(isUnifiedTrafficRequestEligible({ ...base, path: '/.well-known/security.txt' })).toBe(
      false,
    );
  });

  it('excludes only the exact Cloudflare Health Checks token', () => {
    expect(
      isUnifiedTrafficRequestEligible({ ...base, userAgent: 'Cloudflare-Healthchecks/1.0' }),
    ).toBe(false);
    expect(
      isUnifiedTrafficRequestEligible({ ...base, userAgent: 'cloudflare-healthchecks/1.0' }),
    ).toBe(true);
  });
});

describe('unified event bounds', () => {
  it('normalises path and coarse classifications', () => {
    expect(privacySafeUnifiedAnalyticsPath('///docs')).toBe('/docs');
    expect(classifyUnifiedTraffic('/docs', 'Mozilla/5.0')).toBe('browser');
    expect(classifyUnifiedTraffic('/wp-login.php', 'Mozilla/5.0')).toBe('automation');
    expect(classifyUnifiedTraffic('/docs', undefined)).toBe('unknown');
  });

  it('bounds metadata and maps outcomes', () => {
    expect(boundedUnifiedCacheStatus(' hit ')).toBe('HIT');
    expect(boundedUnifiedCountry('sg')).toBe('SG');
    expect(boundedUnifiedCountry('SGP')).toBeNull();
    expect(boundedUnifiedLatencyMs(999_999)).toBe(120_000);
    expect(unifiedTrafficOutcome(200)).toBe('success');
    expect(unifiedTrafficOutcome(206)).toBe('success');
    // A 304 is a successful cache revalidation, not a redirect. The raw status
    // is still stored, and the `outcome` CHECK constraint admits no new value.
    expect(unifiedTrafficOutcome(304)).toBe('success');
    expect(unifiedTrafficOutcome(302)).toBe('redirect');
    expect(unifiedTrafficOutcome(307)).toBe('redirect');
    expect(unifiedTrafficOutcome(404)).toBe('client_error');
    expect(unifiedTrafficOutcome(503)).toBe('server_error');
  });
});

/**
 * Credential redaction for the legacy per-feature recorders.
 *
 * This template's unified stream stores no query string and no referrer, so the
 * NAME-ONLY policy is exercised through `findCredentialParams()` — which is
 * what the route-target guard calls — while the stored bytes are asserted
 * through the two legacy wrappers.
 */
describe('legacy recorder credential redaction', () => {
  const link = (query = '') => new URL(`https://links.example.com/x${query}`);
  const legacy = (query: string) => legacyQueryString(link(query));

  it('redacts only credential-named values, byte-identically otherwise', () => {
    // The legacy tables keep raw fidelity for campaign attribution — utm_* and
    // every other non-sensitive parameter survive byte-identically; only the
    // value of a credential-named parameter is replaced.
    expect(legacy('?token=abc&utm_source=x')).toBe('?token=[redacted]&utm_source=x');
    // No query string at all → NULL, exactly as `url.search || null` produced.
    expect(legacyQueryString(link())).toBeNull();
    // A wholly non-sensitive query is stored byte-identically, encodings included.
    expect(legacy('?utm_source=x&utm_medium=email&q=a%20b')).toBe(
      '?utm_source=x&utm_medium=email&q=a%20b',
    );
    // Stems catch compound provider names; the exact-match group tolerates a
    // PHP/Rails array suffix.
    expect(legacy('?client_secret=s&oauth_token=t&SAMLResponse=r&X-Amz-Signature=g')).toBe(
      '?client_secret=[redacted]&oauth_token=[redacted]&SAMLResponse=[redacted]&X-Amz-Signature=[redacted]',
    );
    expect(legacy('?key[0]=a&api_key[]=b')).toBe('?key[0]=[redacted]&api_key[]=[redacted]');
    // Names that merely START with an exact-match stem stay raw.
    expect(legacy('?codec=h264&keyboard=qwerty&statement=open')).toBe(
      '?codec=h264&keyboard=qwerty&statement=open',
    );
    // A bare flag has no value to replace — the NAME is never the secret.
    expect(legacy('?token&x=1')).toBe('?token&x=1');
  });

  it('never clamps the legacy query string', () => {
    // The attribution parameter sits far beyond any plausible ceiling, so a
    // clamp would silently truncate it away.
    const filler = `pad=${'a'.repeat(4000)}`;
    expect(legacy(`?${filler}&token=live-secret-value&utm_source=newsletter`)).toBe(
      `?${filler}&token=[redacted]&utm_source=newsletter`,
    );
  });

  it('redacts credential values in the referrer without parsing it', () => {
    // Fragment and path survive byte-identically; only the credential value goes.
    expect(legacyReferrer('https://idp.example/verify?token=LIVE&utm_source=x#frag')).toBe(
      'https://idp.example/verify?token=[redacted]&utm_source=x#frag',
    );
    // No query component → returned untouched.
    expect(legacyReferrer('https://news.example/issue-9')).toBe('https://news.example/issue-9');
    // Absent header stays absent (the column is nullable, not empty-string).
    expect(legacyReferrer(undefined)).toBeUndefined();
    expect(legacyReferrer('')).toBe('');
    // NOT a parseable http(s) URL — still redacted, every other byte kept.
    expect(legacyReferrer('android-app://com.example/?token=LIVE')).toBe(
      'android-app://com.example/?token=[redacted]',
    );
    // A bare `?` has no segments to redact — the separator is kept, not dropped.
    expect(legacyReferrer('https://news.example/i?#frag')).toBe('https://news.example/i?#frag');
    expect(legacyReferrer('https://news.example/i?')).toBe('https://news.example/i?');
    // A literal second `?` is query CONTENT — it must survive, and a credential
    // behind it is still caught (`?token` contains the `token` stem).
    expect(legacyReferrer('https://news.example/a??q=x')).toBe('https://news.example/a??q=x');
    expect(legacyReferrer('https://news.example/a??token=LIVE')).toBe(
      'https://news.example/a??token=[redacted]',
    );
    // A `?` that only appears inside the fragment is a hash route, not a query.
    expect(legacyReferrer('https://app.example/p#/route?code=widget')).toBe(
      'https://app.example/p#/route?code=widget',
    );
    // …while a real query BEFORE the fragment is redacted, fragment intact.
    expect(
      legacyReferrer('https://app.example/p?code=4%2FLONG_AUTHORIZATION_CODE_VALUE#/route?x=1'),
    ).toBe('https://app.example/p?code=[redacted]#/route?x=1');
    // A short `code` is a campaign value and survives byte-identically.
    expect(legacyReferrer('https://app.example/p?code=abc#/route?x=1')).toBe(
      'https://app.example/p?code=abc#/route?x=1',
    );
  });

  it('weighs the VALUE of the four ambiguous names', () => {
    // Campaign values are short words: a promo code, a region, an agenda
    // session, a ticket tier. The legacy tables exist to answer exactly these
    // questions, so they survive byte-identically.
    expect(legacy('?code=SUMMER25&state=CA&session=morning&ticket=vip')).toBe(
      '?code=SUMMER25&state=CA&session=morning&ticket=vip',
    );

    // The same four names carrying credential-LENGTH values are redacted.
    const long = 'a'.repeat(LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH);
    expect(legacy(`?code=${long}&state=${long}&session=${long}&ticket=${long}`)).toBe(
      '?code=[redacted]&state=[redacted]&session=[redacted]&ticket=[redacted]',
    );

    // The boundary is inclusive: one character short is still a campaign value.
    // ⚠️ Not `a`.repeat(): `a` is a hex digit, so an all-`a` value of this
    // length trips the hex shape test instead.
    const short = 'z'.repeat(LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH - 1);
    expect(legacy(`?code=${short}`)).toBe(`?code=${short}`);

    // Length is measured on the DECODED value (`+` is a space, `%2F` is one
    // character), so an encoded credential cannot buy itself under the bar.
    expect(legacy(`?state=${'%2F'.repeat(LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH)}`)).toBe(
      '?state=[redacted]',
    );
    expect(legacy('?state=a+b')).toBe('?state=a+b');

    // Array suffixes ride the same rule, on both sides of the threshold.
    expect(legacy('?code[0]=SG&state[]=CA')).toBe('?code[0]=SG&state[]=CA');
    expect(legacy(`?code[0]=${long}`)).toBe('?code[0]=[redacted]');

    // `ticket` is ALSO a substring stem — only the BARE name is ambiguous.
    expect(legacy('?cas_ticket=vip&ticket_id=vip')).toBe(
      '?cas_ticket=[redacted]&ticket_id=[redacted]',
    );
    // `key` is the conventional API-key parameter and is never ambiguous.
    expect(legacy('?key=ab&code_verifier=ab')).toBe('?key=[redacted]&code_verifier=[redacted]');
    // A bare ambiguous flag has no value to weigh and none to redact.
    expect(legacy('?code&x=1')).toBe('?code&x=1');

    // The route-target guard uses the NAME-ONLY predicate, so it still flags
    // the short campaign values. That is the one documented policy difference.
    expect(findCredentialParams('https://a.example/b?code=SUMMER25')).toEqual(['code']);
    // …and the legacy referrer follows the legacy policy, not the name-only one.
    expect(legacyReferrer('https://news.example/i?code=SUMMER25')).toBe(
      'https://news.example/i?code=SUMMER25',
    );
  });

  it('weighs the SHAPE of an ambiguous value, not only its length', () => {
    // Campaign values are words — no shape test fires, whatever their case.
    expect(legacy('?code=SUMMER25')).toBe('?code=SUMMER25');
    expect(legacy('?code=BLACKFRIDAY2026')).toBe('?code=BLACKFRIDAY2026');
    expect(legacy('?code=earlybird2026')).toBe('?code=earlybird2026');
    expect(legacy('?state=MY&session=sg')).toBe('?state=MY&session=sg');

    // Hex at session-id length: an id, a ticket or a digest, never a promo code.
    expect(legacy('?session=a3f9c2e1b4d7f0a9')).toBe('?session=[redacted]');
    expect('a3f9c2e1b4d7f0a9'.length).toBeGreaterThanOrEqual(LEGACY_AMBIGUOUS_MIN_HEX_LENGTH);
    // One character under the hex floor survives.
    expect(legacy('?session=a3f9c2e1b4d')).toBe('?session=a3f9c2e1b4d');

    // Upper + lower + digit at token length: the generated-token shape.
    expect(legacy('?ticket=Xy9kQ2mP1zLw8vRt')).toBe('?ticket=[redacted]');
    expect('Xy9kQ2mP1zLw8vRt'.length).toBeGreaterThanOrEqual(LEGACY_AMBIGUOUS_MIN_MIXED_LENGTH);
    // Missing one of the three classes, so the shape does not fire.
    expect(legacy('?ticket=XYKQMPZLWVRT')).toBe('?ticket=XYKQMPZLWVRT');

    // Documented residual: an OTP-shaped numeric code stays raw.
    expect(legacy('?code=123456')).toBe('?code=123456');
  });

  it('takes one bounded second look at `;` sub-pairs inside a value', () => {
    // Some servers still split a query on `;`, so an inner pair is a real
    // parameter even though the segment's own name is innocuous.
    expect(legacy('?utm_source=x;token=LIVE')).toBe('?utm_source=x;token=[redacted]');
    // A later piece with no `=` is kept, and the first piece is never touched.
    expect(legacy('?a=1;flag;token=LIVE')).toBe('?a=1;flag;token=[redacted]');
    // Nothing sensitive after the `;` → the split/join is byte-identical.
    expect(legacy('?a=1;b=2;flag')).toBe('?a=1;b=2;flag');
    // A sub-pair before the segment's own `=`: the outer name is `plain;code`,
    // which is not a credential name, so the sub-pair is what gets weighed.
    const long = 'a'.repeat(LEGACY_AMBIGUOUS_MIN_CREDENTIAL_LENGTH);
    expect(legacy(`?plain;code=${long}`)).toBe('?plain;code=[redacted]');
    // The referrer inherits the same second look.
    expect(legacyReferrer('https://news.example/i?utm_source=x;token=LIVE#f')).toBe(
      'https://news.example/i?utm_source=x;token=[redacted]#f',
    );
  });

  it('takes one bounded second look inside a nested query', () => {
    // A credential in a return-URL parameter, the shape that motivated this.
    expect(legacy('?next=https%3A%2F%2Fapp.example%2Fverify%3Ftoken%3DLIVE')).toBe(
      '?next=https%3A%2F%2Fapp.example%2Fverify%3Ftoken%3D%5Bredacted%5D',
    );
    // A duplicated `?` inside an ordinary value is a nested query too.
    expect(legacy('?a=1?token=LIVE')).toBe('?a=1%3Ftoken%3D%5Bredacted%5D');
    // The decoded value's fragment survives the rebuild…
    expect(legacy('?next=https%3A%2F%2Fapp.example%3Ftoken%3DLIVE%23done')).toBe(
      '?next=https%3A%2F%2Fapp.example%3Ftoken%3D%5Bredacted%5D%23done',
    );
    // …and a `?` inside the decoded FRAGMENT is scanned too: a fragment reaches
    // the browser intact, so a hash-routed reset link is a live credential.
    expect(legacy('?next=https%3A%2F%2Fapp.example%23%2Fr%3Ftoken%3DLIVE')).toBe(
      `?next=${encodeURIComponent('https://app.example#/r?token=[redacted]')}`,
    );
    // FIDELITY: nothing redacted → stored byte-identically, never re-encoded.
    expect(legacy('?next=https%3A%2F%2Fapp.example%3Fpage%3D2')).toBe(
      '?next=https%3A%2F%2Fapp.example%3Fpage%3D2',
    );
    // Malformed encoding → no second reading of the value exists; kept as sent.
    expect(legacy('?next=%FF%3Ftoken%3DLIVE')).toBe('?next=%FF%3Ftoken%3DLIVE');
    // Depth is exactly ONE: no recursion, no decode loop.
    const twoDeep = `?next=${encodeURIComponent(`https://a.example?next2=${encodeURIComponent('https://b.example?token=LIVE')}`)}`;
    expect(legacy(twoDeep)).toBe(twoDeep);
    // The legacy predicate applies INSIDE the nesting too.
    expect(legacy('?next=https%3A%2F%2Fapp.example%3Fcode%3DSG')).toBe(
      '?next=https%3A%2F%2Fapp.example%3Fcode%3DSG',
    );
  });

  it('never discards one reading’s redactions for the other’s', () => {
    // A value can hide a credential in a `;` sub-pair AND in a nested query at
    // once. Returning after the first reading dropped the other's redactions
    // from the STORED bytes. Exact bytes — what is persisted is the point.

    // 1. A `;` sub-pair AND a nested query in a later piece.
    expect(findCredentialParams('https://a.example/b?a=1;token=LIVE;b=x?key=SECOND')).toEqual([
      'token',
      'key',
    ]);
    expect(legacy('?a=1;token=LIVE;b=x?key=SECOND')).toBe(
      `?a=1;token=[redacted];b=${encodeURIComponent('x?key=[redacted]')}`,
    );

    // 2. A nested query in EACH piece. `code=SECRET` is an ambiguous NAME with
    // a single-case word value, so the legacy rule keeps it; `token` is
    // redacted, which is the fix.
    expect(findCredentialParams('https://a.example/b?a=x?code=SECRET;b=y?token=LIVE')).toEqual([
      'code',
      'token',
    ]);
    expect(legacy('?a=x?code=SECRET;b=y?token=LIVE')).toBe(
      `?a=x?code=SECRET;b=${encodeURIComponent('y?token=[redacted]')}`,
    );

    // 3. The control: it must stay correct AND leave the innocuous piece
    // byte-identical.
    expect(findCredentialParams('https://a.example/b?a=x?page=1;b=y?token=LIVE')).toEqual([
      'token',
    ]);
    expect(legacy('?a=x?page=1;b=y?token=LIVE')).toBe(
      `?a=x?page=1;b=${encodeURIComponent('y?token=[redacted]')}`,
    );

    // A nested URL whose PATH contains a `;` — destroyed by splitting first.
    expect(legacy('?next=https%3A%2F%2Fb.example%2Fpath;v%3Ftoken%3DLIVE')).toBe(
      `?next=${encodeURIComponent('https://b.example/path;v?token=[redacted]')}`,
    );
  });

  it('reads a packed k=v&k=v body inside a decoded value as a PAIR LIST', () => {
    // A decoded value with no `?` and no `#` may itself be a packed query body.
    // Judging the head as ONE pair read only its first name, so the credential
    // after the `&` survived in the stored row and passed the target guard.
    expect(
      findCredentialParams('https://app.example/redir?rt=uid%3D1%26access_token%3Dey.J.9'),
    ).toEqual(['access_token']);
    expect(legacy('?rt=uid%3D1%26access_token%3Dey.J.9')).toBe(
      `?rt=${encodeURIComponent('uid=1&access_token=[redacted]')}`,
    );

    expect(legacy('?a=1;b=x%3D1%26token%3DLIVE')).toBe(
      `?a=1;b=${encodeURIComponent('x=1&token=[redacted]')}`,
    );

    // The outer name is `state`: the NAME-ONLY predicate (and so the guard)
    // flags it and stops there, while the legacy rule keeps its short value as
    // a campaign parameter — and must still scan the PACKED body it carries.
    expect(
      findCredentialParams('https://app.example/redir?state=uid%3D1%26token%3Dabc123'),
    ).toEqual(['state']);
    expect(legacy('?state=uid%3D1%26token%3Dabc123')).toBe(
      `?state=${encodeURIComponent('uid=1&token=[redacted]')}`,
    );

    // Only the credential pair is rewritten; the innocuous tail survives.
    expect(legacy('?a=token%3DLIVE%26x%3D1')).toBe(
      `?a=${encodeURIComponent('token=[redacted]&x=1')}`,
    );
  });

  it('strips URL-removed controls from the decoded nested value', () => {
    // No literal control character anywhere, so the schema and both outer scans
    // see nothing — but the one permitted decode yields `to<TAB>ken=LIVE`, and
    // a browser following that URL sends `token=LIVE`.
    const encodedTab = '?next=https%3A%2F%2Fidp.example%2F%3Fto%09ken%3DLIVE';
    expect(legacy(encodedTab)).toBe(
      `?next=${encodeURIComponent('https://idp.example/?token=[redacted]')}`,
    );
    expect(findCredentialParams(`https://a.example/b${encodedTab}`)).toEqual(['token']);

    // Nothing sensitive behind the control: byte-identical, not re-encoded.
    expect(legacy('?next=https%3A%2F%2Fidp.example%2F%3Fpa%09ge%3D2')).toBe(
      '?next=https%3A%2F%2Fidp.example%2F%3Fpa%09ge%3D2',
    );
  });

  it('findCredentialParams names credential parameters for the route guard', () => {
    expect(findCredentialParams('https://app.example/cb?token=LIVE&utm_source=x')).toEqual([
      'token',
    ]);
    // No `?` at all → nothing to report.
    expect(findCredentialParams('https://app.example/cb')).toEqual([]);
    expect(findCredentialParams('')).toEqual([]);
    // Distinct names in encounter order; VALUES are never returned.
    expect(findCredentialParams('https://a.example/b?token=1&secret=2&token=3')).toEqual([
      'token',
      'secret',
    ]);
    // The NAME-ONLY predicate: an ambiguous name surfaces at any length, so the
    // operator decides.
    expect(findCredentialParams('https://a.example/b?state=CA&session=morning&ticket=vip')).toEqual(
      ['state', 'session', 'ticket'],
    );
    // Names found by the second look are reported under their OWN name.
    expect(
      findCredentialParams('https://a.example/b?next=https%3A%2F%2Fapp.example%3Ftoken%3DLIVE'),
    ).toEqual(['token']);
    expect(findCredentialParams('https://a.example/b?utm_source=x;api_key=k')).toEqual(['api_key']);
    // The name is decoded and trimmed, with its case as the caller wrote it.
    expect(findCredentialParams('https://a.example/b?%20Api%5FKey%20=zz')).toEqual(['Api_Key']);
    // ⚠️ The FRAGMENT is scanned here, unlike the recorders: a route target's
    // fragment is emitted in `Location:` and the browser KEEPS it.
    expect(findCredentialParams('https://a.example/b#/r?token=LIVE')).toEqual(['token']);
    // An implicit-flow fragment body is a segment set, not a path+query.
    expect(findCredentialParams('https://idp.example/cb#access_token=LIVE&state=x')).toEqual([
      'access_token',
      'state',
    ]);
    // BOTH halves of a fragment are scanned: taking only the text after the
    // first `?` dropped the credential sitting before it.
    expect(findCredentialParams('https://app.example/#access_token=LIVE&redirect=/a?b=1')).toEqual([
      'access_token',
    ]);
    expect(findCredentialParams('https://app.example/#access_token=LIVE?x=1')).toEqual([
      'access_token',
    ]);
    // A plain anchor yields nothing.
    expect(findCredentialParams('https://a.example/b#section')).toEqual([]);
    expect(findCredentialParams('https://a.example/b?token=LIVE#access_token=x')).toEqual([
      'token',
      'access_token',
    ]);
  });
});

/**
 * Shapes found by the downstream port reviews and fixed upstream first. Each
 * one hid a credential from the stored row AND from the route-target guard.
 */
describe('legacy recorder redaction — review-found shapes', () => {
  const link = (query = '') => new URL(`https://links.example.com/x${query}`);
  const legacy = (query: string) => legacyQueryString(link(query));

  it('reads the segment as ONE pair before any `;` split', () => {
    // A `;` may sit inside the parameter NAME (`access_token;v=LIVE`: the name
    // is `access_token;v`, which carries the `token` stem) or inside the VALUE
    // after a sensitive name (`token=prefix;SECRET`: the whole value is the
    // secret). The per-piece reading sees `access_token` as a bare flag and
    // `SECRET` as a valueless piece, and would keep both.
    const inName = '?access_token;v=LIVE';
    expect(findCredentialParams(`https://a.example/b${inName}`)).toEqual(['access_token;v']);
    expect(legacy(inName)).toBe('?access_token;v=[redacted]');

    const inValue = '?token=prefix;SECRET';
    expect(findCredentialParams(`https://a.example/b${inValue}`)).toEqual(['token']);
    expect(legacy(inValue)).toBe('?token=[redacted]');

    // Documented cost: a `;`-joined attribution tail after a sensitive name is
    // redacted with it, because a server that does not split on `;` reads it as
    // part of the value. A stored credential is irreversible; the tail is not.
    expect(legacy('?token=x;utm_source=mail')).toBe('?token=[redacted]');
    expect(legacy('?token=LIVE;key=x')).toBe('?token=[redacted]');

    // Innocuous segment names still split and still catch the inner pair.
    expect(legacy('?utm_source=x;token=LIVE')).toBe('?utm_source=x;token=[redacted]');
  });

  it('splits a value on a SECOND `?` as well as the first', () => {
    // The opener consumes only the first `?`, so everything after a second one
    // was never read as a pair list.
    const doubleQ = '?a=1?b=2?token=LIVE';
    expect(findCredentialParams(`https://a.example/b${doubleQ}`)).toEqual(['token']);
    expect(legacy(doubleQ)).toBe(`?a=${encodeURIComponent('1?b=2?token=[redacted]')}`);

    expect(
      findCredentialParams(
        `https://a.example/b?next=${encodeURIComponent('https://x.example/?a=1?token=LIVE')}`,
      ),
    ).toEqual(['token']);

    // A `?` tail after a sensitive name goes WITH its value — see the
    // corrections block below.
    expect(legacy('?a=1?token=LIVE?b=2')).toBe(`?a=${encodeURIComponent('1?token=[redacted]')}`);

    // The benign duplicated-`?` control stays byte-identical.
    expect(legacy('?a=1?page=2;b=3')).toBe('?a=1?page=2;b=3');
  });

  it('reports the pair name, not the URL text, when a decoded PATH carries it', () => {
    // A decoded value that is a URL whose PATH carries the pair must report the
    // parameter's own name — the audit row and the refusal message repeat it.
    const urlHead = `?next=${encodeURIComponent('https://app.example/auth/token=SECRET')}`;
    expect(findCredentialParams(`https://a.example/b${urlHead}`)).toEqual(['token']);
    expect(legacy(urlHead)).toBe(
      `?next=${encodeURIComponent('https://app.example/auth/token=[redacted]')}`,
    );

    // …and a packed body with no slashes is still read as one pair list.
    expect(findCredentialParams('https://a.example/b?rt=uid%3D1%26access_token%3DLIVE')).toEqual([
      'access_token',
    ]);
  });

  it('combines a `;` sub-pair with an encoded URL in the same segment', () => {
    // Both shapes at once: the piecewise reading catches the sub-pair, the
    // whole-value reading catches the nesting, and neither discards the other.
    const combined = '?utm_source=x;next=https%3A%2F%2Fapp.example%3Ftoken%3DLIVE';
    expect(findCredentialParams(`https://a.example/b${combined}`)).toEqual(['token']);
    expect(legacy(combined)).toBe(
      `?utm_source=x;next=${encodeURIComponent('https://app.example?token=[redacted]')}`,
    );
  });

  it('catches a nested query in either ordering of the two pieces', () => {
    // Reversed from the case above: the credential sits in the FIRST piece.
    expect(legacy('?a=y?token=LIVE;b=1')).toBe(
      `?a=${encodeURIComponent('y?token=[redacted]')};b=1`,
    );
    expect(legacy('?a=1;b=y?token=LIVE')).toBe(
      `?a=1;b=${encodeURIComponent('y?token=[redacted]')}`,
    );
  });

  it('keeps `pwd` — it is a path/directory parameter, not a password', () => {
    // `passw` is the stem, so `password` and `passwd` are redacted while the
    // bare `pwd` (conventionally "present working directory") is not.
    expect(legacy('?pwd=/reports/q3')).toBe('?pwd=/reports/q3');
    expect(findCredentialParams('https://a.example/b?pwd=/reports/q3')).toEqual([]);
    expect(legacy('?password=hunter2&passwd=hunter2')).toBe(
      '?password=[redacted]&passwd=[redacted]',
    );
  });
});

/**
 * Corrections to the shapes above, found by review of the first fix.
 *
 * The `?` split inside an already-opened nested query had undone the
 * whole-pair reading, and the unconditional `/` split had broken a packed body
 * whose name or value legitimately contains a slash.
 */
describe('legacy recorder redaction — corrections to the review-found shapes', () => {
  const link = (query = '') => new URL(`https://links.example.com/x${query}`);
  const legacy = (query: string) => legacyQueryString(link(query));
  const e = encodeURIComponent;

  it('reads each `;` piece as a whole pair before splitting it on `?`', () => {
    // A `?` may sit inside the NAME or inside the VALUE after a sensitive name,
    // and a server that does not treat `?` specially inside a query reads both
    // as one pair. Splitting first undid the whole-pair reading.
    expect(
      findCredentialParams(
        `https://a.example/b?next=${e('https://x.example/?access_token?v=LIVE')}`,
      ),
    ).toEqual(['access_token?v']);
    expect(legacy(`?next=${e('https://x.example/?access_token?v=LIVE')}`)).toBe(
      `?next=${e('https://x.example/?access_token?v=[redacted]')}`,
    );
    expect(legacy(`?next=${e('https://x.example/?token=prefix?SECRET')}`)).toBe(
      `?next=${e('https://x.example/?token=[redacted]')}`,
    );

    // An innocuous whole name still falls through to the split — `key` after
    // the `?` is read as a pair, erring toward redaction by design.
    expect(legacy(`?next=${e('https://x.example/?label?key=PUBLIC')}`)).toBe(
      `?next=${e('https://x.example/?label?key=[redacted]')}`,
    );
  });

  it('takes a `?` tail after a sensitive name with its value, like a `;` tail', () => {
    // `LIVE?b=2` is the value as a server that does not treat `?` specially
    // inside a query reads it, so the tail goes with the credential.
    expect(legacy('?a=1?token=LIVE?b=2')).toBe(`?a=${e('1?token=[redacted]')}`);
    // An innocuous name keeps its tail, and the benign control is byte-identical.
    expect(legacy('?a=1?page=2?b=3')).toBe('?a=1?page=2?b=3');
    expect(legacy('?a=1?page=2;b=3')).toBe('?a=1?page=2;b=3');
  });

  it('keeps a `/` that belongs to a packed body name or value', () => {
    // A packed body is NOT a path: splitting it on `/` broke a name or a value
    // that legitimately contains one.
    expect(
      findCredentialParams(`https://a.example/b?rt=${e('uid=1&access_token/v=LIVE')}`),
    ).toEqual(['access_token/v']);
    const slashInValue = e('uid=1&token=prefix/SECRET'); // gitleaks:allow
    expect(legacy(`?rt=${slashInValue}`)).toBe(`?rt=${e('uid=1&token=[redacted]')}`);
  });

  it('still path-scans a bare path, so a credential WORD is not a false positive', () => {
    // No scheme, but a leading `/` — a path. `reset-token` is a path segment,
    // not a parameter name, so nothing is reported or rewritten.
    expect(findCredentialParams(`https://a.example/b?next=${e('/reset-token/k=v')}`)).toEqual([]);
    expect(legacy(`?next=${e('/reset-token/k=v')}`)).toBe(`?next=${e('/reset-token/k=v')}`);
  });
});

/**
 * Second review round: the legacy shape test sees the pre-`;` value, path tails
 * are absorbed into the value they belong to, and a fragment path is read as a
 * path.
 */
describe('legacy recorder redaction — second review round', () => {
  const link = (query = '') => new URL(`https://links.example.com/x${query}`);
  const legacy = (query: string) => legacyQueryString(link(query));
  const e = encodeURIComponent;

  it('judges an ambiguous name on the value UP TO the first `;`', () => {
    // A campaign code with an attribution tail is not a 24-character
    // credential. Reading 0 weighs `SUMMER25`, not `SUMMER25;utm_source=mail`.
    expect(legacy('?code=SUMMER25;utm_source=mail')).toBe('?code=SUMMER25;utm_source=mail');
    expect(legacy('?code=abc;u=Xy1')).toBe('?code=abc;u=Xy1');

    // A genuinely credential-SHAPED value is still redacted, and the sensitive
    // name then takes the whole value, tail included.
    expect(legacy('?session=a3f9c2e1b4d7f0a9;utm=1')).toBe('?session=[redacted]');

    // The route-target guard uses the name-only predicate, so it flags the
    // campaign code regardless — that is the documented policy difference.
    expect(findCredentialParams('https://a.example/b?code=SUMMER25;utm_source=mail')).toEqual([
      'code',
    ]);
  });

  it('reads a hash-route PATH in the fragment as a path', () => {
    // `#/auth/token=SECRET` must report the pair's own name, never the URL text
    // in front of it — the refusal message and the audit row repeat it.
    expect(findCredentialParams('https://app.example/#/auth/token=SECRET')).toEqual(['token']);
  });

  it('treats a scheme-less host-relative head as path-shaped', () => {
    // `app.example/auth/token=S` has no scheme and no leading `/`, but its
    // first segment is host-shaped, so it is a path and not a packed body.
    expect(
      findCredentialParams(`https://a.example/b?next=${e('app.example/auth/token=SECRET')}`),
    ).toEqual(['token']);
  });

  it('absorbs the path segments that are the rest of a redacted value', () => {
    // A redacted pair's VALUE may itself contain `/` — standard base64, Google
    // OAuth codes shaped `4/0A…`. The following non-pair segments are the rest
    // of that value and go with it, rather than being kept as path segments.
    expect(legacy(`?next=${e('https://app.example/cb/access_token=AAAA/BBBBBBBB')}`)).toBe(
      `?next=${e('https://app.example/cb/access_token=[redacted]')}`,
    );

    // A tail that carries its own `=` starts a NEW pair and is read as one.
    expect(legacy(`?next=${e('https://app.example/cb/token=AAAA/key=SECOND')}`)).toBe(
      `?next=${e('https://app.example/cb/token=[redacted]/key=[redacted]')}`,
    );

    // Nothing redacted → the path is byte-identical, absorbing never fires.
    expect(legacy(`?next=${e('https://app.example/a=1/b/c')}`)).toBe(
      `?next=${e('https://app.example/a=1/b/c')}`,
    );
  });
});
