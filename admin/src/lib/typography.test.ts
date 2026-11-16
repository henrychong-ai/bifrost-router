import { describe, expect, test } from 'vitest';
// Vite `?raw` query inlines the file contents as a string — keeps the test
// browser-safe (no node:fs / node:path imports) while still exercising the
// real CSS source. Typed via the `vite/client` types in tsconfig.app.json.
import css from '../index.css?raw';

/**
 * Font stack regression tests (v1.25.0; same-origin fonts since v1.46.1).
 *
 * Guards `admin/src/index.css` against drift on the font stack (Inter and
 * Maple Mono NL, served from `admin/public/fonts/`, and the system CJK stacks
 * for Simplified and Traditional Chinese). The CSS is verified at the source
 * level so a refactor that accidentally strips Maple Mono NL feature settings
 * or CJK locale chains fails the test before it reaches a browser.
 *
 * If you fork bifrost-router and replace the default fonts with your own brand
 * font, update the URLs in this test to match your @font-face declarations —
 * or delete this file entirely if you don't need the regression guardrail.
 */
const cssText = css;
/** The CSS without its comments, so the documented example face is not counted. */
const cssRules = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

describe('typography — font stack', () => {
  test.each([
    ['Inter Variable roman', '/fonts/inter-4.1/inter-variable.woff2'],
    ['Inter Variable italic', '/fonts/inter-4.1/inter-variable-italic.woff2'],
    ['Maple Mono NL roman', '/fonts/maple-mono-7.9/maple-mono-nl.woff2'],
    ['Maple Mono NL italic', '/fonts/maple-mono-7.9/maple-mono-nl-italic.woff2'],
  ])('@font-face declares %s', (_label, url) => {
    expect(cssText).toContain(`url("${url}")`);
  });

  test('every @font-face source is a same-origin path', () => {
    const sources = [...cssRules.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]);
    expect(sources).toHaveLength(4);
    for (const source of sources) expect(source).toMatch(/^\/fonts\//);
  });

  test.each([
    ['Inter', '--font-inter'],
    ['Maple Mono NL', '--font-mono'],
    ['Simplified Chinese', '--font-sans-sc'],
    ['Traditional Chinese', '--font-sans-tc'],
  ])('declares %s family token', (_label, token) => {
    expect(cssText).toContain(token);
  });

  test.each([
    ['--font-sans-sc', ['"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans CJK SC"']],
    ['--font-sans-tc', ['"PingFang TC"', '"Microsoft JhengHei"', '"Noto Sans CJK TC"']],
  ])('%s is a system CJK stack after Inter', (token, families) => {
    const declaration = new RegExp(`${token}:([^;]+);`).exec(cssText)?.[1] ?? '';
    expect(declaration.trim().startsWith('"Inter"')).toBe(true);
    for (const family of families) expect(declaration).toContain(family);
    expect(declaration.trim().endsWith('sans-serif')).toBe(true);
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
    const faces = cssRules.match(/@font-face\s*{[^}]+}/g) ?? [];
    expect(faces).toHaveLength(4);
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/);
    }
  });
});
