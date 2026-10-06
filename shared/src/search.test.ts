import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capSearchParam,
  matchesRouteSearch,
  matchesSearchFields,
  parseSearchQuery,
  qrSearchFields,
  SEARCH_FIELD_MAX_LENGTH,
  SEARCH_PARAM_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MAX_WORDS,
  type SearchableRoute,
  scoreRouteMatch,
  searchAndRankRoutes,
  tokeniseSearchText,
} from './search.js';

describe('tokeniseSearchText', () => {
  it.each([
    ['/summer-sale', ['summer', 'sale']],
    ['Summer_Sale', ['summer', 'sale']],
    ['  --summer...sale//  ', ['summer', 'sale']],
    ['a.b/c-d_e f+g:h', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
    ['https://Example.com/Summer-2026', ['https', 'example', 'com', 'summer', '2026']],
    ['/夏季-促销', ['夏季', '促销']],
    ['Café Zürich', ['café', 'zürich']],
    // Non-ASCII punctuation is part of a word; substring matching absorbs it.
    ['\u201cSummer Sale\u201d', ['\u201csummer', 'sale\u201d']],
    // No percent-decoding: escapes are just text.
    ['/summer%20sale', ['summer', '20sale']],
    ['/-_/.', []],
    ['', []],
  ])('%j → %j', (input, expected) => {
    expect(tokeniseSearchText(input)).toEqual(expected);
  });

  it('reads only the first SEARCH_FIELD_MAX_LENGTH characters', () => {
    const words = tokeniseSearchText(`${'x'.repeat(SEARCH_FIELD_MAX_LENGTH)} tail`);
    expect(words).toEqual(['x'.repeat(SEARCH_FIELD_MAX_LENGTH)]);
  });
});

describe('capSearchParam', () => {
  it('cuts a pasted search to the API bound without splitting a surrogate pair', () => {
    expect(capSearchParam('short')).toBe('short');
    expect(capSearchParam('y'.repeat(3000))).toBe('y'.repeat(SEARCH_PARAM_MAX_LENGTH));
    expect(capSearchParam(`${'x'.repeat(SEARCH_PARAM_MAX_LENGTH - 1)}\u{1F600}`)).toBe(
      'x'.repeat(SEARCH_PARAM_MAX_LENGTH - 1),
    );
  });
});

describe('parseSearchQuery', () => {
  it.each([undefined, null, '', '   ', '\t\n'])('returns null for blank %j', query => {
    expect(parseSearchQuery(query)).toBeNull();
  });

  it('keeps the trimmed lowercase text for the as-typed check and the words', () => {
    expect(parseSearchQuery('  Summer_Sale Brochure ')).toEqual({
      raw: 'summer_sale brochure',
      words: ['summer', 'sale', 'brochure'],
      compact: 'summersalebrochure',
    });
  });

  it('yields no words for a separator-only query', () => {
    expect(parseSearchQuery(' /- ')).toEqual({ raw: '/-', words: [], compact: '' });
  });

  it('cuts a long query to the cap and matches the cut query as typed only', () => {
    const atCap = 'a'.repeat(SEARCH_QUERY_MAX_LENGTH);
    expect(parseSearchQuery(atCap)?.words).toEqual([atCap]);
    expect(parseSearchQuery(`${atCap}b`)).toEqual({ raw: atCap, words: [], compact: '' });
  });

  it('cuts the input to 2x the cap before trimming, and the lowercased query to the cap', () => {
    expect(parseSearchQuery(`   ${'x'.repeat(250)}`)).toEqual({
      raw: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH),
      words: [],
      compact: '',
    });
    const huge = parseSearchQuery(`${'x'.repeat(SEARCH_QUERY_MAX_LENGTH)}${' '.repeat(10_000)}y`);
    expect(huge).toEqual({ raw: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH), words: [], compact: '' });
  });

  it.each([
    ['\u03a3\u0391', 'a sigma followed by a letter'],
    ['\u03a3\u0301\u0391', 'a sigma, an accent, then a letter'],
  ])('keeps the casing context at the cut: %j (%s)', tail => {
    // Without context, a final capital sigma lowercases to final \u03c2, which
    // the field (where the sigma is followed by a letter) does not contain.
    const query = `${'a'.repeat(SEARCH_QUERY_MAX_LENGTH - 1)}${tail}`;
    expect(parseSearchQuery(query)?.raw.endsWith('\u03c3')).toBe(true);
    expect(matchesSearchFields([`/${query}`], query)).toBe(true);
  });

  it('never cuts a surrogate pair in half', () => {
    const emoji = '\u{1F600}';
    // Units 199-200 are the pair: unit 199 (a high surrogate) is dropped with it.
    const straddling = parseSearchQuery(`${'a'.repeat(SEARCH_QUERY_MAX_LENGTH - 1)}${emoji}`);
    expect(straddling?.raw).toBe('a'.repeat(SEARCH_QUERY_MAX_LENGTH - 1));
    // A pair that ends exactly at the cap is kept whole and still word-matched.
    const fitting = parseSearchQuery(`${'a'.repeat(SEARCH_QUERY_MAX_LENGTH - 2)}${emoji}`);
    expect(fitting?.raw).toBe(`${'a'.repeat(SEARCH_QUERY_MAX_LENGTH - 2)}${emoji}`);
    expect(fitting?.words).toHaveLength(1);
  });

  it('caps a query that lowercasing lengthens (200 × U+0130 → 400 units)', () => {
    const dotted = '\u0130'.repeat(SEARCH_QUERY_MAX_LENGTH);
    expect(dotted.toLowerCase()).toHaveLength(2 * SEARCH_QUERY_MAX_LENGTH);
    const parsed = parseSearchQuery(dotted);
    expect(parsed?.raw.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_LENGTH);
    expect(parsed?.words).toEqual([]);
    // The cut needle is a prefix of the full one, so the full match still holds.
    expect(matchesSearchFields([`/${dotted}`], dotted)).toBe(true);
  });

  it('turns word matching off past the word cap', () => {
    const words = Array.from({ length: SEARCH_QUERY_MAX_WORDS + 1 }, (_, i) => `w${i}`);
    expect(parseSearchQuery(words.slice(1).join(' '))?.words).toEqual(words.slice(1));
    expect(parseSearchQuery(words.join(' '))).toEqual({
      raw: words.join(' '),
      words: [],
      compact: '',
    });
  });
});

describe('matchesSearchFields', () => {
  it.each([
    'summer sale',
    'summer-sale',
    'summer_sale',
    'Summer_Sale',
    'summersale',
    'SummerSale',
    'sale summer',
    'Sale-Summer',
    'SUMMER  SALE',
    '/summer-sale',
    'summer.sale',
    'summer/sale',
    'le sum',
    'mer sal',
  ])('query %j finds /summer-sale', query => {
    expect(matchesSearchFields(['/summer-sale'], query)).toBe(true);
  });

  it.each([
    '/summer_sale',
    '/Summer.Sale',
    '/summer/sale',
    'SUMMER SALE',
    '/summersale',
    '/sale-summer',
  ])('query "summer sale" finds field %j', field => {
    expect(matchesSearchFields([field], 'summer sale')).toBe(true);
  });

  it.each([
    ['促销', '/夏季促销'],
    ['夏季 促销', '/夏季促销'],
    ['促销 夏季', '/夏季-促销'],
    ['夏季促销', '/夏季_促销'],
  ])('matches CJK text as substrings: %j finds %j', (query, field) => {
    expect(matchesSearchFields([field], query)).toBe(true);
  });

  it('does not fold accents (intended: other text matches as typed)', () => {
    expect(matchesSearchFields(['Café menu'], 'cafe')).toBe(false);
    expect(matchesSearchFields(['/cafe'], 'café')).toBe(false);
    expect(matchesSearchFields(['Café menu'], 'café')).toBe(true);
    expect(matchesSearchFields(['/café-menu'], 'CAFÉ MENU')).toBe(true);
  });

  it('does not decode percent-escapes (intended: escapes are text)', () => {
    expect(matchesSearchFields(['https://x.com/%E6%A3%AE%E6%9E%97'], '夏季')).toBe(false);
    expect(matchesSearchFields(['https://x.com/%E6%A3%AE%E6%9E%97'], '%e6%a3%ae')).toBe(true);
  });

  it('matches an over-cap query only as typed, never more broadly than legacy', () => {
    const words = Array.from({ length: SEARCH_QUERY_MAX_WORDS }, (_, i) => `w${i}`);
    const field = words.join('-');
    expect(matchesSearchFields([field], words.toReversed().join(' '))).toBe(true);
    expect(matchesSearchFields([`${field}-extra`], `${words.join(' ')} extra`)).toBe(false);
    expect(matchesSearchFields([`${field}-extra`], `${field}-extra`)).toBe(true);
    const long = `summer ${'x'.repeat(SEARCH_QUERY_MAX_LENGTH)} sale`;
    expect(matchesSearchFields([`summer-${'x'.repeat(SEARCH_QUERY_MAX_LENGTH)}-sale`], long)).toBe(
      false,
    );
    expect(matchesSearchFields([`/${long}/`], long)).toBe(true);
    // Cutting keeps every match: the field holds the cut prefix, not the tail.
    expect(matchesSearchFields([`/${long.slice(0, SEARCH_QUERY_MAX_LENGTH)}`], long)).toBe(true);
  });

  it('finds a route by its full, long target URL pasted as the query', () => {
    const target = `https://example.com/campaigns/2026/summer-sale/landing?${Array.from(
      { length: 20 },
      (_, i) => `utm_param_${i}=Summer-Sale-Brochure-Q${i}`,
    ).join('&')}#section`;
    expect(target.length).toBeGreaterThan(4 * SEARCH_QUERY_MAX_LENGTH);
    const routes = [
      { path: '/fc', target, createdAt: 1 },
      { path: '/other', target: 'https://example.com/campaigns/2026/other', createdAt: 2 },
    ];
    expect(searchAndRankRoutes(routes, target).map(r => r.path)).toEqual(['/fc']);
  });

  it('matches words within SEARCH_FIELD_MAX_LENGTH characters; the as-typed check reads all', () => {
    const inside = `${'x'.repeat(SEARCH_FIELD_MAX_LENGTH - '-summer-sale'.length)}-summer-sale`;
    const beyond = `${'x'.repeat(SEARCH_FIELD_MAX_LENGTH)}-summer-sale`;
    expect(inside).toHaveLength(SEARCH_FIELD_MAX_LENGTH);
    expect(matchesSearchFields([inside], 'summer sale')).toBe(true);
    expect(matchesSearchFields([beyond], 'summer sale')).toBe(false);
    expect(matchesSearchFields([beyond], 'summer-sale')).toBe(true);
  });

  it('never combines words from different fields', () => {
    expect(matchesSearchFields(['/github', 'https://x.com'], 'github com')).toBe(false);
    expect(matchesSearchFields(['/github', 'https://github.com'], 'github com')).toBe(true);
    expect(matchesSearchFields(['/summer-sale', 'Brochure for clients'], 'summer brochure')).toBe(
      false,
    );
    expect(matchesSearchFields(['/x', 'Summer Sale brochure'], 'brochure summer')).toBe(true);
  });

  it('falls back to the as-typed match for a separator-only query', () => {
    expect(matchesSearchFields(['/a-b'], '-')).toBe(true);
    expect(matchesSearchFields(['/ab'], '-')).toBe(false);
    expect(matchesSearchFields(['/a'], '/')).toBe(true);
    expect(matchesSearchFields(['a.b'], '//')).toBe(false);
  });

  it('matches everything for a blank query and nothing in empty or missing fields', () => {
    expect(matchesSearchFields([], '')).toBe(true);
    expect(matchesSearchFields(['/x'], '   ')).toBe(true);
    expect(matchesSearchFields(['/x'], undefined)).toBe(true);
    expect(matchesSearchFields(['/x'], null)).toBe(true);
    expect(matchesSearchFields([null, undefined, ''], 'a')).toBe(false);
  });

  it('accepts a pre-parsed query', () => {
    const parsed = parseSearchQuery('sale summer');
    expect(matchesSearchFields(['/summer-sale'], parsed)).toBe(true);
    expect(matchesSearchFields(['/summer'], parsed)).toBe(false);
  });
});

describe('cost stays linear: no Unicode normalisation, bounded tokeniser input', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never calls normalize and never splits more than the window', () => {
    const hostile = [
      '\uFDFA'.repeat(4096),
      `a${[0x483, 0x591, 0xf74, 0xf72, 0xf71, 0x5b0].map(p => String.fromCodePoint(p).repeat(400)).join('')}`,
      '%E6%A3x'.repeat(150_000),
      '夏季促销宣传册、'.repeat(500),
    ];
    const routes = hostile.map((field, i) => ({
      path: `/r${i}`,
      target: field,
      hostHeader: field,
      bucket: field.slice(0, 1000),
    }));
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const splitLengths: number[] = [];
    const { split } = String.prototype;
    vi.spyOn(String.prototype, 'split').mockImplementation(function recordSplit(
      this: string,
      ...args: unknown[]
    ) {
      if (args[0] instanceof RegExp) splitLengths.push(this.length);
      return Reflect.apply(split, this, args) as string[];
    });
    const ranked = searchAndRankRoutes(routes, 'zzqq nomatch');
    const matched = matchesSearchFields(hostile, 'summer sale');
    vi.restoreAllMocks();
    expect(ranked).toEqual([]);
    expect(matched).toBe(false);
    expect(normalize).not.toHaveBeenCalled();
    expect(splitLengths.length).toBeGreaterThan(0);
    expect(Math.max(...splitLengths)).toBeLessThanOrEqual(SEARCH_FIELD_MAX_LENGTH);
  });
});

describe('search field lists', () => {
  it.each([
    ['target', { target: 'https://example.com/Summer-Sale' }, 'sale summer'],
    ['type', { type: 'summer_sale' }, 'sale summer'],
    ['status code', { statusCode: 301 }, '301'],
    ['bucket', { bucket: 'summer-sale' }, 'sale summer'],
    ['host header', { hostHeader: 'summer.sale' }, 'sale summer'],
  ] as Array<[string, Partial<SearchableRoute>, string]>)(
    'route search covers %s',
    (_name, extra, query) => {
      expect(matchesRouteSearch({ path: '/x', ...extra }, query)).toBe(true);
      expect(matchesRouteSearch({ path: '/x' }, query)).toBe(false);
    },
  );

  it('matches the route domain only as typed, so short path queries stay precise', () => {
    const tv = { path: '/a', domain: 'example.tv', target: 'https://example.com' };
    expect(matchesRouteSearch(tv, 'example.tv')).toBe(true);
    expect(matchesRouteSearch(tv, 'Example.TV')).toBe(true);
    expect(matchesRouteSearch(tv, '/tv')).toBe(false);
    expect(matchesRouteSearch(tv, 'example tv')).toBe(false);
    expect(matchesRouteSearch({ ...tv, path: '/tv' }, '/tv')).toBe(true);
  });

  it('QR search covers description and id', () => {
    expect(qrSearchFields({ id: 'abc123', description: 'Office wifi' })).toEqual([
      'Office wifi',
      'abc123',
    ]);
    expect(qrSearchFields({ id: 'abc123' })).toEqual([undefined, 'abc123']);
  });
});

const searchableRoute = (
  path: string,
  createdAt: number,
  extra: Partial<SearchableRoute> = {},
) => ({
  path,
  target: 'https://example.com',
  type: 'redirect',
  createdAt,
  ...extra,
});

describe('scoreRouteMatch and searchAndRankRoutes', () => {
  it('scores exact path, path prefix, path, other-field and no matches in that order', () => {
    expect(scoreRouteMatch(searchableRoute('/summer-sale', 1), 'summer sale')).toBe(4);
    expect(scoreRouteMatch(searchableRoute('/Summer_Sale', 1), 'summersale')).toBe(4);
    expect(scoreRouteMatch(searchableRoute('/summer-sale-brochure', 1), 'summer sale')).toBe(3);
    expect(scoreRouteMatch(searchableRoute('/visit-summer-sale', 1), 'summer sale')).toBe(2);
    expect(scoreRouteMatch(searchableRoute('/a', 1), '/')).toBe(2);
    expect(
      scoreRouteMatch(
        searchableRoute('/fc', 1, { hostHeader: 'summer-sale.example.com' }),
        'summer sale',
      ),
    ).toBe(1);
    expect(
      scoreRouteMatch(searchableRoute('/a', 1, { domain: 'links.example.com' }), 'links.example'),
    ).toBe(1);
    expect(scoreRouteMatch(searchableRoute('/other', 1), 'summer sale')).toBe(0);
    expect(scoreRouteMatch(searchableRoute('/other', 1), '')).toBe(0);
  });

  it('still scores an as-typed path match that word matching misses', () => {
    // Beyond the word window, only the as-typed check sees the path's tail.
    const path = `/${'x'.repeat(SEARCH_FIELD_MAX_LENGTH)}-summer-sale`;
    expect(scoreRouteMatch(searchableRoute(path, 1), 'summer-sale')).toBe(2);
    expect(matchesRouteSearch(searchableRoute(path, 1), 'summer-sale')).toBe(true);
  });

  it('matchesRouteSearch matches every route for a blank query', () => {
    expect(matchesRouteSearch(searchableRoute('/a', 1), '   ')).toBe(true);
    expect(matchesRouteSearch(searchableRoute('/a', 1), null)).toBe(true);
  });

  it('keeps matches only, ranked by score, then newest first, then input order', () => {
    const routes = [
      searchableRoute('/fc-note', 50, { target: 'https://example.com/summer-sale' }),
      searchableRoute('/unrelated', 99),
      searchableRoute('/visit-summer-sale', 10),
      searchableRoute('/summer-sale-old', 1),
      searchableRoute('/summer-sale-new', 2),
      searchableRoute('/summer-sale', 0),
      searchableRoute('/visit-summer-sale-too', 10),
    ];
    const before = routes.map(r => r.path);
    expect(searchAndRankRoutes(routes, 'summer sale').map(r => r.path)).toEqual([
      '/summer-sale',
      '/summer-sale-new',
      '/summer-sale-old',
      '/visit-summer-sale',
      '/visit-summer-sale-too',
      '/fc-note',
    ]);
    expect(routes.map(r => r.path)).toEqual(before);
  });

  it('treats a missing createdAt as oldest on ties', () => {
    const routes = [
      { path: '/summer-a' },
      searchableRoute('/summer-b', 5),
      searchableRoute('/summer-c', 9),
    ];
    expect(searchAndRankRoutes(routes, 'summer').map(r => r.path)).toEqual([
      '/summer-c',
      '/summer-b',
      '/summer-a',
    ]);
  });

  it('returns a copy of every route, in input order, for a blank query', () => {
    const routes = [searchableRoute('/a', 1), searchableRoute('/b', 5)];
    const result = searchAndRankRoutes(routes, '  ');
    expect(result).toEqual(routes);
    expect(result).not.toBe(routes);
  });
});

describe('a realistic route list', () => {
  // 370 mostly-ASCII routes, newest first, a tenth
  // with CJK paths, and short CJK, accented or Korean text in another field.
  const notes = [
    '夏季促销宣传册 2026 年版',
    'Café résumé brochure for the Zürich office — final',
    '서울 사무소 안내 페이지',
    'Campaign landing page',
  ];
  const routes = Array.from({ length: 370 }, (_, i) => ({
    path: i % 10 === 0 ? `/夏季-${i}` : `/campaign-${i}`,
    type: 'redirect',
    target: `https://example.com/landing/${i}?utm_source=newsletter`,
    bucket: `${notes[i % notes.length]} #${i}`,
    createdAt: 370 - i,
  }));

  it('lists the exact path first, then path prefixes newest first', () => {
    expect(
      searchAndRankRoutes(routes, 'campaign 7')
        .slice(0, 10)
        .map(r => r.path),
    ).toEqual(['/campaign-7', ...[71, 72, 73, 74, 75, 76, 77, 78, 79].map(n => `/campaign-${n}`)]);
  });

  it('finds CJK paths first, then other fields, for a CJK query', () => {
    const ranked = searchAndRankRoutes(routes, '夏季').map(r => r.path);
    const cjkPaths = routes.filter(r => r.path.startsWith('/夏季')).map(r => r.path);
    expect(ranked.slice(0, cjkPaths.length)).toEqual(cjkPaths);
    expect(ranked.length).toBeGreaterThan(cjkPaths.length);
  });
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const legacy = (fields: Array<string | undefined>, term: string) =>
  !term ||
  fields
    .filter((f): f is string => Boolean(f))
    .some(f => f.toLowerCase().includes(term.toLowerCase()));

/**
 * Superset guarantee: anything the pre-v1.38.0 search found must still be
 * found. Seeded (mulberry32) so a failure reproduces exactly.
 */
describe('legacy superset (seeded generative)', () => {
  const ALPHABET = [
    ...'abcxyzABCXYZ0129',
    ...' -_/.:?=&%#+~',
    ...'éÉüÜçßİıΣσς',
    'e\u0301',
    ...'夏季促销ガカ',
    '\uFF9E',
    'ﬁ',
    'Ｆ',
    '%20',
    '%E6',
    '%41',
    '\u{1d49c}',
  ];

  function generate(random: () => number, maxTokens: number) {
    const length = Math.floor(random() * maxTokens);
    let out = '';
    for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return out;
  }

  it('every legacy match on a substring of a field is still a match', () => {
    const random = mulberry32(0x5eed1077);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const field = generate(random, 24);
      const start = Math.floor(random() * (field.length + 1));
      const end = start + Math.floor(random() * (field.length - start + 1));
      const term = field.slice(start, end);
      if (!term.trim() || !legacy([field], term)) continue;
      checked++;
      expect(
        matchesSearchFields([field], term),
        `${JSON.stringify(field)} / ${JSON.stringify(term)}`,
      ).toBe(true);
    }
    // Guard against a vacuous pass.
    expect(checked).toBeGreaterThan(2000);
  });

  it('every legacy match is still a match for queries past the cap (Greek, Turkish)', () => {
    const random = mulberry32(0xc0ffee);
    const LONG = [
      ...'abcABC09 -_/.',
      '\u03a3', // capital sigma: final-sigma context at the cut
      '\u03c3',
      '\u03c2',
      '\u0391',
      '\u0301', // case-ignorable accent between a sigma and a letter
      '\u0130', // dotted capital I: lowercases to two units
      '\u0131',
      'I',
      'i',
    ];
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const length = SEARCH_QUERY_MAX_LENGTH + 1 + Math.floor(random() * 220);
      let field = '';
      while (field.length < length + 40) field += LONG[Math.floor(random() * LONG.length)];
      const start = Math.floor(random() * 40);
      const term = field.slice(start, start + length);
      if (!term.trim() || !legacy([field], term)) continue;
      checked++;
      expect(
        matchesSearchFields([field], term),
        `${JSON.stringify(field)} / ${JSON.stringify(term)}`,
      ).toBe(true);
    }
    // Guard against a vacuous pass.
    expect(checked).toBeGreaterThan(1000);
  });

  it('every legacy route match is still a route match', () => {
    const random = mulberry32(0xb1f2057);
    let legacyMatches = 0;
    for (let i = 0; i < 3000; i++) {
      const route = {
        path: `/${generate(random, 10)}`,
        target: `https://${generate(random, 14)}`,
        type: 'redirect',
        statusCode: random() < 0.5 ? 301 : undefined,
        domain: random() < 0.5 ? 'links.example.com' : undefined,
        hostHeader: random() < 0.3 ? generate(random, 6) : undefined,
        bucket: random() < 0.3 ? generate(random, 6) : undefined,
      };
      const term = generate(random, 3) || ALPHABET[Math.floor(random() * ALPHABET.length)];
      const legacyFields = [
        route.path,
        route.target,
        route.type,
        route.statusCode?.toString(),
        route.domain,
        route.hostHeader,
        route.bucket,
      ];
      if (!term.trim() || !legacy(legacyFields, term)) continue;
      legacyMatches++;
      expect(
        matchesRouteSearch(route, term),
        `${JSON.stringify(route)} / ${JSON.stringify(term)}`,
      ).toBe(true);
    }
    // Guard against a vacuous pass.
    expect(legacyMatches).toBeGreaterThan(300);
  });
});
