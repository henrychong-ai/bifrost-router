import { describe, expect, test } from 'vitest';
// Vite `?raw` query inlines the file contents as a string — keeps the test
// browser-safe (no node:fs / node:path imports) while still exercising the
// real CSS source. Typed via the `vite/client` types in tsconfig.app.json.
import css from '../index.css?raw';

/**
 * Four-font stack regression tests (v1.25.0).
 *
 * Guards `admin/src/index.css` against drift on the canonical four-font stack
 * (Inter / Maple Mono NL / Noto Sans SC / Noto Sans TC). The CSS is verified at
 * the source level so a refactor that accidentally strips Maple Mono NL feature
 * settings or CJK locale chains fails the test before it reaches a browser.
 *
 * If you fork bifrost-router and replace the default fonts with your own brand
 * font, update the URLs in this test to match your @font-face declarations —
 * or delete this file entirely if you don't need the regression guardrail.
 */
const cssText = css as string;

describe('typography — four-font stack', () => {
  test.each([
    ['Inter Variable roman', 'https://assets.fusang.co/fonts/inter/inter-variable.woff2'],
    ['Inter Variable italic', 'https://assets.fusang.co/fonts/inter/inter-variable-italic.woff2'],
    ['Maple Mono NL roman', 'https://assets.fusang.co/fonts/maple/maple-mono-nl.woff2'],
    ['Maple Mono NL italic', 'https://assets.fusang.co/fonts/maple/maple-mono-nl-italic.woff2'],
    ['Noto Sans SC variable', 'https://assets.fusang.co/fonts/noto-sans/noto-sans-sc.woff2'],
    ['Noto Sans TC variable', 'https://assets.fusang.co/fonts/noto-sans/noto-sans-tc.woff2'],
  ])('@font-face declares %s', (_label, url) => {
    expect(cssText).toContain(url);
  });

  test.each([
    ['Inter', '--font-inter'],
    ['Maple Mono NL', '--font-mono'],
    ['Noto Sans SC', '--font-sans-sc'],
    ['Noto Sans TC', '--font-sans-tc'],
  ])('declares %s family token', (_label, token) => {
    expect(cssText).toContain(token);
  });

  test('body engages Inter v4 opsz axis (font-optical-sizing: auto)', () => {
    expect(cssText).toMatch(/body\s*{[^}]*font-optical-sizing:\s*auto/);
  });

  test('mono surfaces (code/pre/kbd/samp) bind --font-mono', () => {
    expect(cssText).toMatch(/code,\s*\n\s*pre,\s*\n\s*kbd,\s*\n\s*samp\s*{/);
    expect(cssText).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  test.each([
    ['cv01', /"cv01"\s+1/],
    ['cv32', /"cv32"\s+1/],
    ['cv33', /"cv33"\s+1/],
    ['cv34', /"cv34"\s+1/],
    ['cv35', /"cv35"\s+1/],
    ['cv36', /"cv36"\s+1/],
    ['cv37', /"cv37"\s+1/],
  ])('Maple Mono NL %s feature setting is active', (_label, pattern) => {
    expect(cssText).toMatch(pattern);
  });

  test('Maple Mono feature settings are DRY via --mono-features (defined once with the full cv set, referenced on both surfaces)', () => {
    // Defined exactly once, carrying the FULL cv set — a truncation regression
    // (e.g. dropping cv32-cv37) must fail here, not slip through on the cv01 token
    // appearing elsewhere in the file.
    const defs = cssText.match(/--mono-features:[^;]*;/g) ?? [];
    expect(defs).toHaveLength(1);
    for (const cv of ['cv01', 'cv32', 'cv33', 'cv34', 'cv35', 'cv36', 'cv37']) {
      expect(defs[0]).toContain(`"${cv}" 1`);
    }
    // ...and applied via var() on BOTH mono surfaces (base code/pre/kbd/samp rule and
    // the .font-mono utility) so the two can't drift.
    const refs = cssText.match(/font-feature-settings:\s*var\(--mono-features\)/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  test('CJK locale scoping is present', () => {
    expect(cssText).toMatch(/\[lang\^="zh-Hans"\]/);
    expect(cssText).toMatch(/\[lang\^="zh-Hant"\]/);
  });

  test('font-display: swap on every face declaration', () => {
    const faces = cssText.match(/@font-face\s*{[^}]+}/g) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(6);
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/);
    }
  });
});
