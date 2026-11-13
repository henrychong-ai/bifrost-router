import { describe, expect, it } from 'vitest';
import { fenceMarkdownText, markdownCodeSpan } from '../../src/utils/markdown-literal';

describe('fenceMarkdownText', () => {
  it('fences text with no backticks in three backticks and the `text` info string', () => {
    expect(fenceMarkdownText('# heading\n<b>x</b>')).toBe('```text\n# heading\n<b>x</b>\n```');
  });

  it('makes the fence one longer than the longest backtick run, never shorter than three', () => {
    expect(fenceMarkdownText('a `b` c')).toBe('```text\na `b` c\n```');
    expect(fenceMarkdownText('```\nclose?')).toBe('````text\n```\nclose?\n````');
    expect(fenceMarkdownText('x ````` y')).toBe('``````text\nx ````` y\n``````');
  });

  it('normalises CRLF, bare CR and the Unicode line and paragraph separators to LF', () => {
    expect(fenceMarkdownText('a\r\nb\rc\u2028d\u2029e')).toBe('```text\na\nb\nc\nd\ne\n```');
  });
});

describe('markdownCodeSpan', () => {
  it('wraps a value with no backticks in single backticks', () => {
    expect(markdownCodeSpan('[x](https://example.com) <img>')).toBe(
      '`[x](https://example.com) <img>`',
    );
  });

  it('makes the delimiter one longer than the longest backtick run', () => {
    expect(markdownCodeSpan('a``b')).toBe('```a``b```');
  });

  it('pads a value that starts or ends with a backtick or a space', () => {
    expect(markdownCodeSpan('`x')).toBe('`` `x ``');
    expect(markdownCodeSpan('x`')).toBe('`` x` ``');
    expect(markdownCodeSpan(' x')).toBe('`  x `');
  });

  it('turns every line break a renderer may honour into a space', () => {
    expect(markdownCodeSpan('a\r\nb\rc\nd\ve\ff\u0085g\u2028h\u2029i')).toBe('`a b c d e f g h i`');
  });
});
