import { describe, expect, it } from 'vitest';
import { applyUtm, parseUtm, UTM_FIELD_HELP, UTM_KEYS, uppercaseUtmKeys } from './utm';

describe('parseUtm', () => {
  it('reads all five names and decodes values, lowercased as saved with whitespace intact', () => {
    expect(
      parseUtm(
        'https://example.com/?utm_source=News+Letter&utm_medium=%20EMAIL%20&utm_campaign=Q4&utm_term=a%26b&utm_content=%E9%9B%AA',
      ),
    ).toEqual({
      utm_source: 'news letter',
      utm_medium: ' email ',
      utm_campaign: 'q4',
      utm_term: 'a&b',
      utm_content: '雪',
    });
  });
  it('reads the first duplicate, recognises encoded names and empty values, and ignores fragments and differently cased names', () => {
    expect(
      parseUtm(
        'https://example.com/?%75tm_source=first&utm_source=second&utm_medium&UTM_CAMPAIGN=OTHER#?utm_term=fragment',
      ),
    ).toEqual({ utm_source: 'first', utm_medium: '' });
    expect(parseUtm('https://example.com/path#utm_source=fragment')).toEqual({});
  });
  it.each(['', '/relative', 'not a URL', 'https://[bad'])(
    'returns null for invalid target %j',
    target => {
      expect(parseUtm(target)).toBeNull();
    },
  );
});

describe('applyUtm', () => {
  // UTM values are already lowercase; the scheme, host, fragment and other names are not.
  const raw =
    'HTTPS://EXAMPLE.COM:443/a%2fb?x=%20&x=+&&%75tm_source=one&utm_source=two&bare&tilde=~#Frag?x=%2f';
  it('preserves an untouched lowercase target byte-for-byte, even with existing duplicate UTM values', () => {
    expect(applyUtm(raw, {})).toBe(raw);
    expect(applyUtm(raw, { utm_medium: undefined })).toBe(raw);
  });
  it('adds trimmed lowercase values without normalising unrelated bytes', () => {
    expect(applyUtm(raw, { utm_medium: '  EMail + / 雪  ' })).toBe(
      'HTTPS://EXAMPLE.COM:443/a%2fb?x=%20&x=+&&%75tm_source=one&utm_source=two&bare&tilde=~&utm_medium=email+%2B+%2F+%E9%9B%AA#Frag?x=%2f',
    );
  });
  it('replaces every occurrence of only explicitly edited keys, including percent-encoded names', () => {
    expect(applyUtm(raw, { utm_source: 'New' })).toBe(
      'HTTPS://EXAMPLE.COM:443/a%2fb?x=%20&x=+&&bare&tilde=~&utm_source=new#Frag?x=%2f',
    );
    expect(
      applyUtm('https://example.com/?UTM_SOURCE=Keep&utm_source=old', { utm_source: 'Next' }),
    ).toBe('https://example.com/?UTM_SOURCE=Keep&utm_source=next');
  });
  it('removes all explicitly cleared keys while preserving unrelated query pairs and the fragment', () => {
    expect(applyUtm(raw, { utm_source: ' \t ' })).toBe(
      'HTTPS://EXAMPLE.COM:443/a%2fb?x=%20&x=+&&bare&tilde=~#Frag?x=%2f',
    );
    expect(
      applyUtm('https://example.com/?utm_source=a&utm_source=b#Frag', { utm_source: '' }),
    ).toBe('https://example.com/#Frag');
  });
  it('adds before fragments and handles targets with no query or an empty query', () => {
    expect(applyUtm('https://example.com#frag?x=y', { utm_campaign: 'Launch' })).toBe(
      'https://example.com?utm_campaign=launch#frag?x=y',
    );
    expect(applyUtm('https://example.com?', { utm_campaign: 'Launch' })).toBe(
      'https://example.com?&utm_campaign=launch',
    );
    expect(
      applyUtm('https://example.com', {
        utm_source: 'Source',
        utm_medium: 'Medium',
        utm_campaign: 'Campaign',
        utm_term: 'Term',
        utm_content: 'Content',
      }),
    ).toBe(
      'https://example.com?utm_source=source&utm_medium=medium&utm_campaign=campaign&utm_term=term&utm_content=content',
    );
  });
  it.each(['https://example.com', 'https://example.com?', 'https://example.com?x=1#fragment'])(
    'clearing an absent key preserves %s exactly',
    target => {
      expect(applyUtm(target, { utm_source: '' })).toBe(target);
    },
  );
  it('keeps an unrelated empty pair when removing the sole named parameter', () => {
    expect(applyUtm('https://example.com?utm_source=a&', { utm_source: '' })).toBe(
      'https://example.com?',
    );
  });
  it('treats separators, nested URL-looking values, and malformed escapes as data', () => {
    const target =
      'https://example.com/?next=https%3A%2F%2Fx.test%2F%3Futm_source%3Dinner&bad=%ZZ#utm_source=hash';
    expect(applyUtm(target, { utm_source: 'a&token=fixture#frag?x=y' })).toBe(
      target.replace(
        '#utm_source=hash',
        '&utm_source=a%26token%3Dfixture%23frag%3Fx%3Dy#utm_source=hash',
      ),
    );
    expect(parseUtm(applyUtm(target, { utm_content: '\ud800' }))).toEqual({
      utm_content: '\ufffd',
    });
  });
  it('does not impose a target length limit and preserves unedited tracking on each reapplication', () => {
    const target = `https://example.com/?long=${'a'.repeat(10000)}&utm_medium=%20old%20`;
    const next = applyUtm(target, { utm_source: 'New' });
    expect(next).toBe(target + '&utm_source=new');
    expect(applyUtm(next, { utm_source: 'New' })).toBe(next);
    expect(UTM_KEYS).toHaveLength(5);
  });
  it('rejects malformed URLs even for an untouched submission', () => {
    expect(() => applyUtm('not a URL', {})).toThrow(TypeError);
    expect(() => applyUtm('/relative', { utm_source: 'News' })).toThrow(TypeError);
  });
});

describe('URL parser fidelity regressions', () => {
  it('keeps a literal question mark in a parameter name separate from an edited UTM key', () => {
    const target = 'https://example.com/??utm_source=Keep&utm_source=Old&?utm_medium=AlsoKeep';
    expect(applyUtm(target, { utm_source: 'New', utm_medium: 'Email' })).toBe(
      'https://example.com/??utm_source=Keep&?utm_medium=AlsoKeep&utm_source=new&utm_medium=email',
    );
  });
  it.each([
    ['https://example.com/path ', 'https://example.com/path?utm_source=news '],
    [' https://example.com/?x=1 ', ' https://example.com/?x=1&utm_source=news '],
    ['https://example.com/?x=1#Frag  ', 'https://example.com/?x=1&utm_source=news#Frag  '],
  ])('keeps parser-trimmed whitespace outside the URL when editing %j', (target, expected) => {
    const merged = applyUtm(target, { utm_source: 'News' });
    expect(merged).toBe(expected);
    expect(new URL(merged).pathname).toBe(new URL(target).pathname);
    expect(new URL(merged).searchParams.get('x')).toBe(new URL(target).searchParams.get('x'));
    expect(new URL(merged).hash).toBe(new URL(target).hash);
  });
});

describe('lowercase UTM values', () => {
  it('lists keys with any non-lowercase value, including later duplicates and encoded letters', () => {
    expect(
      uppercaseUtmKeys(
        'https://example.com/?utm_source=one&utm_source=Two&utm_medium=%45mail&utm_campaign=Sale+X&utm_term=ok&utm_content=%c3%89',
      ),
    ).toEqual(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']);
  });
  it('ignores lowercase values with uppercase percent escapes, other names, and the fragment', () => {
    expect(
      uppercaseUtmKeys(
        'HTTPS://EXAMPLE.COM/A?utm_content=%E9%9B%AA&utm_term=%20x%20&UTM_SOURCE=Keep&?utm_medium=Keep#utm_campaign=Frag',
      ),
    ).toEqual([]);
    expect(uppercaseUtmKeys('not a URL')).toEqual([]);
  });
  it('lowercases a target value with capitals as an edit, leaving other bytes intact', () => {
    expect(applyUtm('HTTPS://EXAMPLE.COM/A?utm_source=NewsLetter&x=Keep#Frag', {})).toBe(
      'HTTPS://EXAMPLE.COM/A?x=Keep&utm_source=newsletter#Frag',
    );
    expect(
      applyUtm('https://example.com/?utm_medium=%20E-Mail%20&utm_source=ok', {
        utm_term: undefined,
      }),
    ).toBe('https://example.com/?utm_source=ok&utm_medium=e-mail');
  });
  it('collapses mixed-case duplicates to the lowercased first value', () => {
    expect(applyUtm('https://example.com/?utm_source=one&x=1&utm_source=Two#F', {})).toBe(
      'https://example.com/?x=1&utm_source=one#F',
    );
    expect(applyUtm('https://example.com/?%75tm_source=Mixed&utm_source=other', {})).toBe(
      'https://example.com/?utm_source=mixed',
    );
    // A blank first value saves as blank, which removes the key, as a cleared edit does.
    expect(applyUtm('https://example.com/?utm_source=&utm_source=ABC&x=1', {})).toBe(
      'https://example.com/?x=1',
    );
  });
  it('lets explicit edits and clears win over the converted target value', () => {
    const target = 'https://example.com/?utm_source=NEWS&utm_medium=Email';
    expect(applyUtm(target, { utm_source: 'Other', utm_medium: '' })).toBe(
      'https://example.com/?utm_source=other',
    );
  });
  it('lowercases non-ASCII values with Unicode case mapping and UTF-8 encoding', () => {
    const target = 'https://example.com/?utm_campaign=%C3%89T%C3%89-%C3%9Cn%C3%AF&utm_content=雪';
    expect(uppercaseUtmKeys(target)).toEqual(['utm_campaign']);
    const merged = applyUtm(target, { utm_source: 'ΟΔΟΣ', utm_term: 'İ ẞ' });
    expect(merged).toBe(
      'https://example.com/?utm_content=雪&utm_source=%CE%BF%CE%B4%CE%BF%CF%82&utm_campaign=%C3%A9t%C3%A9-%C3%BCn%C3%AF&utm_term=i%CC%87+%C3%9F',
    );
    expect(parseUtm(merged)).toEqual({
      utm_source: 'οδος',
      utm_campaign: 'été-ünï',
      utm_term: 'i̇ ß',
      utm_content: '雪',
    });
    expect(uppercaseUtmKeys(merged)).toEqual([]);
    expect(applyUtm(merged, {})).toBe(merged);
  });
  it('matches names split by tabs or newlines the way the URL parser reads them', () => {
    expect(applyUtm('https://example.com/?utm_\tsource=Tab&x=1', {})).toBe(
      'https://example.com/?x=1&utm_source=tab',
    );
    expect(applyUtm('https://example.com/?utm_so\nurce=old&x=1', { utm_source: 'new' })).toBe(
      'https://example.com/?x=1&utm_source=new',
    );
  });
  it.each([
    'HTTPS://EXAMPLE.COM:443/a%2fb?x=%20&%75tm_source=One&utm_source=Two&bare#Frag?utm_term=X',
    'https://example.com/??utm_source=Keep&utm_medium=%4D&utm_medium=m&&utm_term',
    'https://example.com/?utm_campaign=A%26B+C&utm_content=%ZZ%41&utm_\tterm=T ',
  ])('always yields lowercase, idempotent UTM values for %j', target => {
    for (const edits of [{}, { utm_source: ' Edit ' }, { utm_medium: '' }]) {
      const merged = applyUtm(target, edits);
      const params = new URL(merged).searchParams;
      for (const key of UTM_KEYS) {
        for (const value of params.getAll(key)) expect(value).toBe(value.toLowerCase());
      }
      expect(new URL(merged).hash).toBe(new URL(target).hash);
      expect(applyUtm(merged, {})).toBe(merged);
    }
  });
});

describe('UTM_FIELD_HELP', () => {
  it('gives every UTM field a label and a purpose with kebab-case examples', () => {
    expect(Object.keys(UTM_FIELD_HELP)).toEqual([...UTM_KEYS]);
    const kebab = '[a-z0-9]+(?:-[a-z0-9]+)*';
    for (const key of UTM_KEYS) {
      expect(UTM_FIELD_HELP[key].label).toMatch(/^[A-Z][a-z]+$/);
      expect(UTM_FIELD_HELP[key].hint).toMatch(
        new RegExp(`\\. Examples: ${kebab}(?:, ${kebab})+\\.$`),
      );
    }
  });
});
