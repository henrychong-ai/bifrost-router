import { describe, expect, it } from 'vitest';
// oxlint-disable-next-line import/default -- Vite ?raw imports return source text
import indexHtmlSource from '../../index.html?raw';
import { stripHtmlComments, stripHtmlCommentsFromHtml } from './strip-html-comments';

describe('stripHtmlCommentsFromHtml', () => {
  it('removes an ordinary HTML comment', () => {
    expect(stripHtmlCommentsFromHtml('<p>a</p><!-- note --><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  it('removes multi-line and multiple comments', () => {
    const html = '<!--\n  line one\n  line two\n--><div/><!-- second -->';
    expect(stripHtmlCommentsFromHtml(html)).toBe('<div/>');
  });

  it('preserves conditional and hydration-marker comments', () => {
    const html = '<!--[if IE]><p>ie</p><![endif]--><!--[--><span/>';
    expect(stripHtmlCommentsFromHtml(html)).toBe(html);
  });

  it('leaves comment-free markup byte-identical', () => {
    const html = '<div class="a">text</div>';
    expect(stripHtmlCommentsFromHtml(html)).toBe(html);
  });

  it('does not eat markup between two separate comments', () => {
    // A greedy `[\s\S]*` would swallow the <main> element between them.
    expect(stripHtmlCommentsFromHtml('<!-- a --><main/><!-- b -->')).toBe('<main/>');
  });

  it('removes a comment that only forms once an inner comment is removed', () => {
    // One pass removes `<!-- a -->` and leaves `<!-` + `-`, which reads as a new
    // comment opener: the outer note would ship.
    expect(stripHtmlCommentsFromHtml('<!-<!-- a -->- outer note --><p/>')).toBe('<p/>');
  });

  it('keeps going until no comment is left, however deeply one is nested', () => {
    const html = '<!-<!-<!-- a -->- b -->- c --><p/>';
    expect(stripHtmlCommentsFromHtml(html)).toBe('<p/>');
  });

  it('is stable: stripping its own output changes nothing', () => {
    const once = stripHtmlCommentsFromHtml('<!-<!-- a -->- b --><p/><!--[if IE]><![endif]-->');
    expect(stripHtmlCommentsFromHtml(once)).toBe(once);
  });

  it('refuses a comment that is never closed instead of shipping it', () => {
    expect(() => stripHtmlCommentsFromHtml('<p/><!-- never closed <b/>')).toThrow(
      /unterminated HTML comment/,
    );
  });

  it('does not treat a preserved marker as unterminated', () => {
    expect(stripHtmlCommentsFromHtml('<!--[--><span/>')).toBe('<!--[--><span/>');
  });
});

describe('the shipped SPA shell', () => {
  it('carries comments in source that the transform removes entirely', () => {
    // Both halves matter: the source keeps its rationale, and the artefact
    // ships none of it. A vacuous test (no comments in source) would pass the
    // second assertion while proving nothing.
    expect(indexHtmlSource).toContain('<!--');
    expect(stripHtmlCommentsFromHtml(indexHtmlSource)).not.toContain('<!--');
  });
});

describe('stripHtmlComments plugin', () => {
  it('applies on build only, after other transforms', () => {
    const plugin = stripHtmlComments();
    expect(plugin.name).toBe('strip-html-comments');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
  });

  it('transforms index HTML through the plugin hook', () => {
    expect(stripHtmlComments().transformIndexHtml('<b/><!-- x -->')).toBe('<b/>');
  });
});
