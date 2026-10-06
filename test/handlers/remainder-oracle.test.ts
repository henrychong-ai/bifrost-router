/**
 * Proxy wildcard remainder: a property test over upstream behaviour (v1.37.2).
 *
 * The proxy forwards the visitor's raw remainder once its decoded text passes
 * the segment rules. This file checks that choice against what upstream
 * servers actually do with a path:
 *   1. upstream models: each is one thing a real upstream does to the path it
 *      receives (decode once, decode leniently, strip `;params`, treat `+` as
 *      space, NFKC, Win32 trailing dot and space trimming, NUL truncation,
 *      WHATWG reparsing, dropping ignorable code points, NTFS stream names,
 *      best-fit code-page mapping of look-alike slashes, colons and percent
 *      signs, `\` as `/`, resolving dot segments);
 *   2. the property: for every path the proxy FORWARDS, the closure of the
 *      forwarded path under every composition of those models never leaves
 *      the target's base path, never becomes host-relative (`//x`), and never
 *      does so after a prefix-stripping upstream removes the base;
 *   3. known attack vectors, a seeded fuzz over path atoms, a parity table of
 *      legitimate inputs whose forwarding must not change, and the
 *      legitimate inputs the rules knowingly refuse.
 *
 * Adding an upstream model is one entry in MODELS: the fuzz then shows what
 * the segment rules must gain.
 */
import { describe, expect, it } from 'vitest';
import { proxyDestination } from '../../src/handlers/proxy';
import type { KVRouteConfig } from '../../src/types';

// ---------------------------------------------------------------- routes
function docsRouteTo(target: string): KVRouteConfig {
  return { path: '/docs/*', type: 'proxy', target, createdAt: 0, updatedAt: 0 };
}
const ROUTES = {
  base: { route: docsRouteTo('https://up.example/base'), base: '/base' },
  root: { route: docsRouteTo('https://up.example'), base: '' },
} as const;

/** The upstream pathname a visitor path would fetch, or null when refused. */
function forwarded(route: KVRouteConfig, visitorPath: string): string | null {
  let url: URL;
  try {
    url = new URL(`https://link.example${visitorPath}`);
  } catch {
    return null;
  }
  // The runtime's own parser may already have resolved the path out of the route
  if (url.pathname !== '/docs' && !url.pathname.startsWith('/docs/')) return null;
  return proxyDestination(route, url)?.pathname ?? null;
}

// ---------------------------------------------------------------- models
type Model = (path: string) => string | null; // null: the upstream rejects it (safe)
const ABOVE_ROOT = '/__ABOVE_ROOT__';
const HOST_CHANGE = '/__HOST_CHANGE__';

function perSegment(f: (segment: string) => string | null): Model {
  return path => {
    const out: string[] = [];
    for (const segment of path.split('/')) {
      const r = f(segment);
      if (r === null) return null;
      out.push(r);
    }
    return out.join('/');
  };
}

/** UTF-8 decoding that ACCEPTS overlong forms (`%c0%ae` = `.`); invalid bytes read as Latin-1. */
function lenientUtf8(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let n = 0;
    let cp = 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    if ((b & 0xe0) === 0xc0) {
      n = 1;
      cp = b & 0x1f;
    } else if ((b & 0xf0) === 0xe0) {
      n = 2;
      cp = b & 0x0f;
    } else if ((b & 0xf8) === 0xf0) {
      n = 3;
      cp = b & 0x07;
    } else {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    let ok = i + n < bytes.length;
    for (let k = 1; ok && k <= n; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    i += n + 1;
  }
  return out;
}

/** StringPrep table B.1, as code points. */
const STRINGPREP_B1: ReadonlySet<number> = new Set([
  0xad,
  0x34f,
  0x1806,
  0x180b,
  0x180c,
  0x180d,
  0x200b,
  0x200c,
  0x200d,
  0x2060,
  ...Array.from({ length: 16 }, (_, index) => 0xfe00 + index),
  0xfeff,
]);

const MODELS: Record<string, Model> = {
  // one strict decode (Node, nginx, Apache, Go, most frameworks)
  decodeStrict: perSegment(s => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  }),
  // a lenient byte decoder: %u, overlong UTF-8, invalid bytes as Latin-1
  decodeLenient: perSegment(s => {
    s = s.replace(/%u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        for (const b of new TextEncoder().encode(s[i])) bytes.push(b);
      }
    }
    return lenientUtf8(bytes);
  }),
  plusAsSpace: p => p.replace(/\+/g, ' '),
  // Tomcat / Jetty / Spring path parameters, before or after decoding (closure covers both orders)
  stripParams: perSegment(s => s.split(';', 1)[0]),
  // an upstream that re-splits a decoded `?` or `#`
  cutQueryOrFragment: p => p.split(/[?#]/, 1)[0],
  nfkc: p => p.normalize('NFKC'),
  // Win32/IIS: trailing dots and spaces dropped; worst case an all-dot name is read as `..`
  trimWin32: perSegment(s => {
    if (s === '.' || s === '..') return s;
    const t = s.replace(/[. ]+$/, '');
    return t === '' && s.includes('.') ? '..' : t;
  }),
  nulTruncate: p => p.split('\0', 1)[0],
  // WHATWG input stripping, and upstreams that drop ignorable code points
  stripTabNewline: p => p.replace(/[\t\n\r]/g, ''),
  stripIgnorable: p => p.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ''),
  // StringPrep table B.1: code points commonly mapped to nothing
  stringPrepB1: p =>
    [...p].filter(character => !STRINGPREP_B1.has(character.codePointAt(0) ?? 0)).join(''),
  // Python, Go and .NET style trimming of Unicode White_Space (NEL included)
  trimWhiteSpace: perSegment(s => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')),
  // an upstream that drops combining marks (NFD, then remove \p{M})
  stripMarks: p => p.normalize('NFD').replace(/\p{M}/gu, ''),
  // NTFS/IIS: `name:stream` names the file `name` (`..:` is the parent)
  ntfsStream: perSegment(s => s.split(':', 1)[0] ?? ''),
  // best-fit code-page conversion of look-alike slashes (the acute accent
  // among them), colons and the Arabic percent sign
  bestFitSlash: p => p.replace(/[\u2215\u2044\u29f8\u00b4]/gu, '/').replace(/\u2216/gu, '\\'),
  bestFitColon: p => p.replace(/[\u2236\u0589]/gu, ':'),
  bestFitPercent: p => p.replace(/\u066a/gu, '%'),
  backslashAsSlash: p => p.replace(/\\/g, '/'),
  // an upstream that reparses the path with the WHATWG URL parser
  whatwgReparse: p => {
    try {
      const u = new URL(p, 'http://host.invalid');
      return u.hostname === 'host.invalid' ? u.pathname : HOST_CHANGE;
    } catch {
      return null;
    }
  },
  resolveDots: p => {
    if (p === HOST_CHANGE || p === ABOVE_ROOT) return p;
    const stack: string[] = [];
    for (const s of p.split('/').slice(1)) {
      if (s === '.') continue;
      if (s === '..') {
        if (stack.length === 0) return ABOVE_ROOT;
        stack.pop();
        continue;
      }
      stack.push(s);
    }
    return `/${stack.join('/')}`;
  },
};

/** Whether a path an upstream may be holding has left `base` (or become host-relative). */
function escapes(path: string, base: string): boolean {
  if (path === HOST_CHANGE || path === ABOVE_ROOT) return true;
  if (path.startsWith('//')) return true; // host-relative at an upstream that reparses
  if (base !== '' && path.startsWith(`${base}//`)) return true; // host-relative after a prefix-stripping upstream
  const resolved = MODELS.resolveDots(MODELS.backslashAsSlash(path) ?? path) ?? path;
  if (resolved === ABOVE_ROOT || resolved === HOST_CHANGE) return true;
  if (base === '') return false;
  return !(resolved === base || resolved.startsWith(`${base}/`));
}

/**
 * The first member of the closure of `start` under MODELS that escapes `base`,
 * with the model chain that reached it, or null. Bounded: the models are
 * contractive, so closures stay small (cap hits are reported as failures).
 */
function findEscape(
  start: string,
  base: string,
  cap = 600,
): { via: string[]; result: string } | null {
  const seen = new Map<string, string[]>([[start, []]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const via = seen.get(current) as string[];
    if (escapes(current, base)) return { via, result: current };
    if (seen.size > cap) return { via: ['closure-cap'], result: current };
    for (const [name, model] of Object.entries(MODELS)) {
      let next: string | null;
      try {
        next = model(current);
      } catch {
        next = null;
      }
      if (next === null || seen.has(next)) continue;
      seen.set(next, [...via, name]);
      queue.push(next);
    }
  }
  return null;
}

/** Check every route for `visitorPath`; returns how many of them forwarded it. */
function expectNoEscape(visitorPath: string): number {
  let forwardedCount = 0;
  for (const { route, base } of Object.values(ROUTES)) {
    const path = forwarded(route, visitorPath);
    if (path === null) continue; // refused: nothing reaches the upstream
    forwardedCount += 1;
    const escape = findEscape(path, base);
    // The failure message names the input, what was forwarded and the chain
    expect(
      escape
        ? `${visitorPath} forwarded as ${path} escapes via ${escape.via.join(' > ')} = ${JSON.stringify(escape.result)}`
        : null,
    ).toBeNull();
  }
  return forwardedCount;
}

// ---------------------------------------------------------------- generator
const ATOMS = [
  '.',
  '..',
  '%2e',
  '%2E',
  '%252e',
  '%c0%ae',
  '%25c0%25ae',
  '%e0%80%ae',
  '%f0%80%80%ae',
  '%25f0%2580%2580%25ae',
  ';',
  '%3b',
  '%253b',
  '/',
  '%2f',
  '%252f',
  '\\',
  '%5c',
  '%255c',
  '%00',
  '%2500',
  '%09',
  '%2509',
  '%0a',
  '%250a',
  '%0d',
  '%250d',
  '%7f',
  '%257f',
  '%20',
  '%2520',
  ' ',
  '+',
  '%2b',
  '%252b',
  '?',
  '%3f',
  '%253f',
  '#',
  '%23',
  '%2523',
  '%u002e',
  '%25u002e',
  '%E2%80%A5',
  '%EF%BC%8E',
  '%EF%BC%8F',
  '%EF%BC%BC',
  '%EF%BC%9B',
  '%E3%80%80',
  '%C2%A0',
  '%E2%80%8B',
  '%EF%BB%BF',
  '%EF%BC%85',
  '%EF%BC%92',
  '%EF%BC%A5',
  '%E2%80%A6',
  '%E2%81%84',
  '%E2%88%95',
  '%C2%85',
  '%E2%80%A8',
  '%CC%81',
  '%C2%B4',
  '%E2%88%B6',
  '%D6%89',
  '%D9%AA',
  '%EF%B9%AA',
  'a',
  'x',
  'admin',
  '100%25',
  '%',
  '%2',
  '%zz',
  '%C3%A9',
  '%E9',
  '~',
  '%7e',
  '%41',
  '@',
  ':',
  '=',
  '&',
  ',',
  '$',
  '!',
  "'",
  '(',
  ')',
  '*',
  '[',
  ']',
  '|',
  '%7c',
  '%5e',
  'jsessionid=X',
  '..file',
  'v1.2',
];

/** Deterministic PRNG (mulberry32) so a failing case reproduces from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Escapes written in fragments: a percent sign (ASCII or fullwidth) and two
 * hex digits (ASCII or fullwidth), with an ignorable code point or a
 * combining mark possibly between each, so that the escape only appears once
 * an upstream drops it or applies NFKC.
 */
const FRAGMENTED_ESCAPES: string[] = (() => {
  const out: string[] = [];
  for (const percent of ['%25', '%EF%BC%85', '%EF%B9%AA', '%D9%AA']) {
    for (const gap of ['', '%E2%80%8B', '%C2%AD', '%EF%BB%BF', '%CC%81', '%CD%8F']) {
      for (const high of ['2', '5', '%EF%BC%92']) {
        for (const low of ['e', 'E', 'f', 'c', '%EF%BD%85', '%EF%BC%A5']) {
          out.push(`${percent}${gap}${high}${gap}${low}`);
        }
      }
    }
  }
  return out;
})();

function randomFragmentedPath(random: () => number): string {
  const pick = () => FRAGMENTED_ESCAPES[Math.floor(random() * FRAGMENTED_ESCAPES.length)];
  const shapes = [
    () => `/docs/${pick()}${pick()}/admin`,
    () => `/docs/..${pick()}/admin`,
    () => `/docs/${pick()}/y`,
    () => `/docs/a${pick()}${pick()}${pick()}b`,
  ];
  return shapes[Math.floor(random() * shapes.length)]?.() ?? '/docs/a';
}

function randomVisitorPath(random: () => number): string {
  const segments: string[] = [];
  const count = 1 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    let s = '';
    const atoms = Math.floor(random() * 4) + (i === 0 ? 1 : 0);
    for (let k = 0; k < atoms; k++) s += ATOMS[Math.floor(random() * ATOMS.length)];
    segments.push(s);
  }
  return `/docs/${segments.join('/')}`;
}

// ---------------------------------------------------------------- tests
describe('proxy wildcard remainder: no upstream model leaves the base path', () => {
  it.each([
    // backslash and path-parameter traversal
    '/docs/..%5c..%5cadmin',
    '/docs/..;x/admin',
    '/docs/%2e%2e;x/admin',
    '/docs/..%3Bx/admin',
    '/docs/a%2f..%2f..%2fadmin',
    // double encoding and controls
    '/docs/%252e%252e/admin',
    '/docs/..%253b/admin',
    '/docs/%25c0%25ae/admin',
    '/docs/%25u002e/admin',
    '/docs/..%00/admin',
    // residual escapes a double-decoding upstream resolves
    '/docs/..%2509/admin',
    '/docs/..%250a/admin',
    '/docs/..%250d/admin',
    '/docs/a%2500b/../admin',
    '/docs/..%253F/admin',
    '/docs/..%25f0%2580%2580%25ae/admin',
    '/docs/..%25u0009/admin',
    '/docs/%25u002e%25u002e/admin',
    // NFKC look-alikes, including fullwidth `;` and `%`
    '/docs/%E2%80%A5/admin',
    '/docs/%EF%BC%8E%EF%BC%8E/admin',
    '/docs/%E2%80%A4%E2%80%A4/admin',
    '/docs/%EF%B9%92%EF%B9%92/admin',
    '/docs/.%EF%BC%8E/admin',
    '/docs/..%EF%BC%9Bx/admin',
    '/docs/..%EF%BC%85%EF%BC%92%EF%BC%A5/admin',
    '/docs/%E2%80%A6/admin',
    // Win32 trimming, `+` as space, re-split at `?`/`#`, ignorables
    '/docs/..%20/admin',
    '/docs/.../admin',
    '/docs/..%3F/admin',
    '/docs/..+/admin',
    '/docs/..%23x/admin',
    '/docs/..%E3%80%80/admin',
    '/docs/..%C2%A0/admin',
    '/docs/..%E2%80%8B/admin',
    // C1 controls, Unicode White_Space and combining marks
    '/docs/..%C2%85/admin',
    '/docs/%C2%85/y',
    '/docs/..%E2%80%A8/admin',
    '/docs/..%CC%81/admin',
    // a code point StringPrep maps to nothing
    '/docs/..%E1%A0%86/admin',
    '/docs/...%E1%A0%86/admin',
    // NTFS stream suffixes and division-slash look-alikes
    '/docs/..:/admin',
    '/docs/..::$INDEX_ALLOCATION/admin',
    '/docs/..%E2%88%95admin',
    // more best-fit look-alikes: the acute accent as a slash, the ratio sign
    // and the Armenian full stop as colons, the Arabic percent sign
    '/docs/..%C2%B4..%C2%B4x',
    '/docs/a%C2%B4..%C2%B4..%C2%B4admin',
    '/docs/..%E2%88%B6%E2%88%B6$INDEX_ALLOCATION/admin',
    '/docs/..%E2%88%B6/admin',
    '/docs/..%D6%89/admin',
    '/docs/%D9%AA2e%D9%AA2e/admin',
    '/docs/..%D9%AA2f..%D9%AA2fadmin',
    // escapes split by an ignorable code point
    '/docs/%25%E2%80%8B2e%25%E2%80%8B2e/admin',
    '/docs/%252%E2%80%8Be%252%E2%80%8Be/admin',
    // escapes split by a combining mark
    '/docs/%25%CC%812e%25%CC%812e/admin',
    '/docs/%252%CC%81e%252%CC%81e/admin',
    '/docs/..%EF%BB%BF/admin',
    // parameter-only or collapsible segments on a root target, and leading empty segments
    '/docs/;/y',
    '/docs/x/../;/y',
    '/docs/%3B/y',
    '/docs/%20/y',
    '/docs/+/y',
    '/docs//evil.example/x',
    '/docs//x',
  ])('%s never resolves outside the base under any model chain', visitorPath => {
    expectNoEscape(visitorPath);
  });

  it('holds for generated paths (seeded fuzz)', () => {
    const random = prng(0x5eed);
    let forwardedPaths = 0;
    for (let i = 0; i < 20000; i++) forwardedPaths += expectNoEscape(randomVisitorPath(random));
    // The property is only as strong as what reaches it: thousands of the
    // generated paths are forwarded, not refused
    expect(forwardedPaths).toBeGreaterThan(2000);
  });

  it('holds for escapes written in fragments (seeded fuzz)', () => {
    const random = prng(0xf4a6);
    for (let i = 0; i < 5000; i++) expectNoEscape(randomFragmentedPath(random));
  });

  // The segment rules rely on both in the Workers runtime
  it('has NFKC normalisation and the Default_Ignorable_Code_Point property', () => {
    expect('\u2025'.normalize('NFKC')).toBe('..');
    expect('\uFF0F'.normalize('NFKC')).toBe('/');
    expect(/^\p{Default_Ignorable_Code_Point}$/u.test('\u200B')).toBe(true);
    expect(/^\p{Default_Ignorable_Code_Point}$/u.test('a')).toBe(false);
  });
});

describe('proxy wildcard remainder: legitimate paths forward unchanged', () => {
  const { route } = ROUTES.base;
  it.each([
    ['/docs/a/b/c.html', '/base/a/b/c.html'],
    ['/docs/100%25.pdf', '/base/100%25.pdf'],
    ['/docs/50%25off', '/base/50%25off'],
    ['/docs/caf%C3%A9/%E2%9C%93', '/base/caf%C3%A9/%E2%9C%93'],
    ['/docs/%E4%B8%AD%E6%96%87', '/base/%E4%B8%AD%E6%96%87'],
    ['/docs/a%20b', '/base/a%20b'],
    ['/docs/a;b/c', '/base/a;b/c'],
    ['/docs/page;jsessionid=X', '/base/page;jsessionid=X'],
    ['/docs/a%3Bb', '/base/a%3Bb'],
    ['/docs/a/', '/base/a/'],
    ['/docs', '/base'],
    ['/docs/', '/base'],
    ['/docs/a//b', '/base/a//b'],
    ['/docs/..file/v1.2', '/base/..file/v1.2'],
    ['/docs/.hidden', '/base/.hidden'],
    ['/docs/a..', '/base/a..'],
    ['/docs/pkg@1.2.3/index.js', '/base/pkg@1.2.3/index.js'],
    ['/docs/pkg%401.2.3', '/base/pkg%401.2.3'],
    ['/docs/v1/x:run', '/base/v1/x:run'],
    ['/docs/a+b', '/base/a+b'],
    ['/docs/a%2Bb', '/base/a%2Bb'],
    ['/docs/k=v&x=y', '/base/k=v&x=y'],
    ['/docs/a,b$c', '/base/a,b$c'],
    ['/docs/a[b]|c', '/base/a[b]|c'],
    ["/docs/a'b", "/base/a'b"],
    ['/docs/a%3Fb', '/base/a%3Fb'],
    ['/docs/%C2%A5100.html', '/base/%C2%A5100.html'],
    ['/docs/%E2%9D%A4%EF%B8%8F', '/base/%E2%9D%A4%EF%B8%8F'],
    ['/docs/%F0%9F%91%A8%E2%80%8D%F0%9F%92%BB', '/base/%F0%9F%91%A8%E2%80%8D%F0%9F%92%BB'],
    ['/docs/cafe%CC%81', '/base/cafe%CC%81'],
    // look-alike colons and percent signs elsewhere still forward
    ['/docs/a%E2%88%B6b', '/base/a%E2%88%B6b'],
    ['/docs/%D9%AA', '/base/%D9%AA'],
    ['/docs/x/../y', '/base/y'], // the runtime's parser resolved it before the Worker saw it
  ])('%s forwards as %s', (visitorPath, expected) => {
    expect(forwarded(route, visitorPath)).toBe(expected);
  });

  it.each([
    ['a bare percent sign', '/docs/100%.pdf'],
    ['a literal percent before two hex characters (accepted cost)', '/docs/50%25de.pdf'],
    ['Latin-1 bytes', '/docs/caf%E9'],
    ['a double-encoded @ (residual escape)', '/docs/a%2540b'],
    ['an encoded slash', '/docs/@scope%2fpkg'],
    ['a parameter-only segment', '/docs/;jsessionid=X/y'],
    ['an all-dot name', '/docs/...'],
    ['a leading empty segment', '/docs//x'],
    ['a dot name with an NTFS stream suffix', '/docs/..:'],
    ['a dot name with a named NTFS stream', '/docs/..::$INDEX_ALLOCATION'],
    ['a segment starting with a colon', '/docs/:x'],
    ['a division slash', '/docs/a%E2%88%95b'],
    ['a fraction slash', '/docs/a%E2%81%84b'],
    ['a set minus', '/docs/a%E2%88%96b'],
    ['an acute accent (best-fit slash)', '/docs/caf%C2%B4e'],
    ['a dot name before a ratio sign (best-fit colon)', '/docs/..%E2%88%B6x'],
    ['a dot name before an Armenian full stop (best-fit colon)', '/docs/..%D6%89'],
    ['an Arabic percent sign before two hex digits', '/docs/50%D9%AA25'],
  ])('refuses %s with no upstream fetch (documented behaviour change)', (_label, visitorPath) => {
    expect(forwarded(route, visitorPath)).toBeNull();
  });
});
