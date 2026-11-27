/**
 * The link-preview document (v1.48.0): its data (`buildLinkPreviewDocument`)
 * and its HTML (`renderLinkPreviewHtml`). Hostile titles and descriptions
 * never leave their attribute or element.
 */
import { PREVIEW_DEFAULT_IMAGES, PREVIEW_SITE_NAMES } from '@bifrost/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { KVRouteConfig } from '../../src/types';
import { escapeHtml } from '../../src/utils/html-escape';
import {
  buildLinkPreviewDocument,
  type LinkPreviewDocument,
  routeServablePreview,
} from '../../src/utils/link-preview';
import { renderLinkPreviewHtml } from '../../src/utils/link-preview-html';
import { usePreviewBuckets } from '../link-preview-config';

usePreviewBuckets();

const route = (overrides: Partial<KVRouteConfig> = {}): KVRouteConfig => ({
  path: '/doc',
  type: 'r2',
  target: 'docs/report.pdf',
  previewTitle: 'Report',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const url = (href: string) => new URL(href);

/** The document for a route's stored preview, as the serving branch builds it. */
function documentFor(r: KVRouteConfig, href: string, key: string, contentType: string) {
  const preview = routeServablePreview(r);
  return preview
    ? buildLinkPreviewDocument(preview, r.bucket ?? 'files', url(href), key, contentType)
    : null;
}

describe('routeServablePreview', () => {
  it('is null without a title, and for any part out of shape', () => {
    expect(routeServablePreview(route({ previewTitle: undefined }))).toBeNull();
    for (const change of [
      { previewTitle: 'x'.repeat(121) },
      { previewTitle: ' padded ' },
      { previewDescription: 'x'.repeat(241) },
      { previewImageBucket: 'assets' },
      {
        previewImageBucket: 'constructor',
        previewImageKey: 'a.png',
        previewImageWidth: 1,
        previewImageHeight: 1,
      },
      {
        previewImageBucket: 'files-user1',
        previewImageKey: 'a.png',
        previewImageWidth: 1,
        previewImageHeight: 1,
      },
      {
        previewImageBucket: 'assets',
        previewImageKey: '   ',
        previewImageWidth: 1,
        previewImageHeight: 1,
      },
      {
        previewImageBucket: 'assets',
        previewImageKey: '../a.png',
        previewImageWidth: 1,
        previewImageHeight: 1,
      },
      { previewImageBucket: 'assets', previewImageKey: 'a.png' },
      {
        previewImageBucket: 'assets',
        previewImageKey: 'a.png',
        previewImageWidth: 1,
        previewImageHeight: 16_385,
      },
      { previewVideoWidth: 1280 },
      { previewVideoWidth: 1280, previewVideoHeight: 0 },
    ]) {
      expect({ change, preview: routeServablePreview(route(change)) }).toEqual({
        change,
        preview: null,
      });
    }
  });

  it('a complete preview passes whole; nulls read as absent', () => {
    expect(
      routeServablePreview(
        route({
          previewDescription: 'About',
          previewImageBucket: 'assets',
          previewImageKey: 'cards/a.png',
          previewImageWidth: 1200,
          previewImageHeight: 630,
          previewVideoWidth: 1920,
          previewVideoHeight: 1080,
        }),
      ),
    ).toEqual({
      title: 'Report',
      description: 'About',
      image: { bucket: 'assets', key: 'cards/a.png', width: 1200, height: 630 },
      video: { width: 1920, height: 1080 },
    });
    expect(
      routeServablePreview({
        ...route(),
        previewDescription: null,
        previewImageBucket: null,
      } as unknown as KVRouteConfig),
    ).toEqual({ title: 'Report' });
  });
});

describe('buildLinkPreviewDocument', () => {
  const siteNames = PREVIEW_SITE_NAMES as Record<string, string | null>;
  afterEach(() => {
    siteNames['links.example.com'] = null;
  });

  it('a title alone: website card, short link without query, file address, no site name', () => {
    expect(
      documentFor(
        route(),
        'https://links.example.com/doc?utm_source=x#top',
        'docs/report.pdf',
        'application/pdf',
      ),
    ).toEqual({
      title: 'Report',
      url: 'https://links.example.com/doc',
      type: 'website',
      fileUrl: 'https://files.example.com/docs/report.pdf',
    });
  });

  it('names the site an operator sets for the host', () => {
    siteNames['links.example.com'] = 'Example Links';
    expect(
      documentFor(route(), 'https://links.example.com/doc', 'docs/report.pdf', 'application/pdf')
        ?.siteName,
    ).toBe('Example Links');
  });

  it('chooses the image custom domain in the request host zone, else the first', () => {
    const withImage = route({
      previewImageBucket: 'assets',
      previewImageKey: 'cards/a b.png',
      previewImageWidth: 1200,
      previewImageHeight: 630,
    });
    const net = documentFor(
      withImage,
      'https://secondary.example.net/doc',
      'docs/report.pdf',
      'application/pdf',
    );
    expect(net?.image).toEqual({
      url: 'https://assets.example.net/cards/a%20b.png',
      width: 1200,
      height: 630,
      alt: 'Report',
    });
    // The file's bucket has one custom domain, in another zone: that one
    expect(net?.fileUrl).toBe('https://files.example.com/docs/report.pdf');
    // A host in no configured zone: the first domain
    expect(
      documentFor(withImage, 'https://unknown.example.org/doc', 'k', 'application/pdf')?.image?.url,
    ).toBe('https://assets.example.com/cards/a%20b.png');
  });

  it('a file bucket with no custom domain gives no file address', () => {
    const doc = documentFor(
      route({ bucket: 'files-user1' }),
      'https://links.example.com/doc',
      'k',
      'text/html',
    );
    expect(doc?.fileUrl).toBeUndefined();
  });

  it('video tags only for mp4/webm with both sizes and a file address', () => {
    const video = route({ previewVideoWidth: 1280, previewVideoHeight: 720 });
    const mp4 = documentFor(
      video,
      'https://links.example.com/film',
      'films/a.mp4',
      'video/mp4; codecs="avc1"',
    );
    expect(mp4?.type).toBe('video.other');
    expect(mp4?.video).toEqual({
      url: 'https://files.example.com/films/a.mp4',
      type: 'video/mp4',
      width: 1280,
      height: 720,
    });
    expect(documentFor(video, 'https://links.example.com/f', 'a', 'video/webm')?.video?.type).toBe(
      'video/webm',
    );
    const mov = documentFor(video, 'https://links.example.com/f', 'a', 'video/quicktime');
    expect(mov?.type).toBe('video.other');
    expect(mov?.video).toBeUndefined();
    expect(
      documentFor(route(), 'https://links.example.com/f', 'a', 'video/mp4')?.video,
    ).toBeUndefined();
    expect(
      documentFor(
        { ...video, bucket: 'files-user1' },
        'https://links.example.com/f',
        'a',
        'video/mp4',
      )?.video,
    ).toBeUndefined();
  });

  describe('the default image per domain (an injected map)', () => {
    const defaultImage = {
      bucket: 'assets',
      key: 'previews/default.png',
      width: 1200,
      height: 630,
    };
    const defaults = { 'links.example.com': defaultImage };
    const build = (r: KVRouteConfig, href: string, map: Record<string, unknown> = defaults) => {
      const preview = routeServablePreview(r);
      if (!preview) return null;
      return buildLinkPreviewDocument(
        preview,
        'files',
        url(href),
        'docs/report.pdf',
        'application/pdf',
        map as Parameters<typeof buildLinkPreviewDocument>[5],
      );
    };

    it('a titled route with no image shows its domain default, with its stored size', () => {
      expect(build(route(), 'https://links.example.com/doc')?.image).toEqual({
        url: 'https://assets.example.com/previews/default.png',
        width: 1200,
        height: 630,
        alt: 'Report',
      });
    });

    it("the route's own image wins over the default", () => {
      const own = route({
        previewImageBucket: 'files',
        previewImageKey: 'cards/own.jpg',
        previewImageWidth: 800,
        previewImageHeight: 800,
      });
      expect(build(own, 'https://links.example.com/doc')?.image).toEqual({
        url: 'https://files.example.com/cards/own.jpg',
        width: 800,
        height: 800,
        alt: 'Report',
      });
    });

    it('another domain, an inherited name or a non-preview bucket gets no default', () => {
      expect(build(route(), 'https://example.com/doc')?.image).toBeUndefined();
      // An inherited host name (`constructor`) is covered by the shared previewCard tests
      for (const bucket of ['files-user1', 'constructor', 'no-such-bucket']) {
        expect(
          build(route(), 'https://links.example.com/doc', {
            'links.example.com': { ...defaultImage, bucket },
          })?.image,
        ).toBeUndefined();
      }
    });

    it('a stored preview out of shape still means no card: the default never stands in', () => {
      expect(
        build(route({ previewImageBucket: 'assets' }), 'https://links.example.com/doc'),
      ).toBeNull();
      expect(
        build(route({ previewTitle: ' padded ' }), 'https://links.example.com/doc'),
      ).toBeNull();
    });

    it('the shipped map, every entry null, changes nothing against no map at all', () => {
      for (const r of [route(), route({ previewDescription: 'About' })]) {
        for (const href of ['https://links.example.com/doc', 'https://example.com/doc']) {
          expect(build(r, href, PREVIEW_DEFAULT_IMAGES)).toEqual(build(r, href, {}));
        }
      }
    });
  });
});

const hostile = [
  '"><script>alert(1)</script>',
  "' onmouseover='x",
  'Tom & Jerry <b>bold</b>',
  'line one\nline two\r\nthree',
  '‮evil.exe‬ العربية',
  'Launch 🚀🇸🇬 👨‍👩‍👧',
  '</title><meta property="og:image" content="https://evil.example/x.png">',
];

const doc = (title: string, description: string): LinkPreviewDocument => ({
  title,
  description,
  url: 'https://links.example.com/doc?x="y"',
  siteName: 'Example',
  type: 'website',
  image: { url: 'https://assets.example.com/a.jpg', width: 1200, height: 630, alt: title },
  fileUrl: 'https://files.example.com/a.pdf',
});

describe('renderLinkPreviewHtml', () => {
  it('puts meta charset first in head, then the title and the tags', () => {
    const html = renderLinkPreviewHtml(doc('Report', 'About'));
    const head = html.slice(html.indexOf('<head>') + '<head>'.length).trimStart();
    expect(head.startsWith('<meta charset="utf-8">\n<title>Report</title>')).toBe(true);
    for (const tag of [
      '<meta property="og:title" content="Report">',
      '<meta property="og:description" content="About">',
      '<meta property="og:site_name" content="Example">',
      '<meta property="og:type" content="website">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:alt" content="Report">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="Report">',
      '<meta name="twitter:description" content="About">',
      '<meta name="twitter:image" content="https://assets.example.com/a.jpg">',
      '<meta name="robots" content="noindex, nofollow">',
      '<body><h1>Report</h1><p><a href="https://files.example.com/a.pdf">Open file</a></p></body>',
    ]) {
      expect(html).toContain(tag);
    }
    expect(html).not.toMatch(/<script|<style|<link/i);
  });

  it('omits what is absent: description, site name, image, file link', () => {
    const html = renderLinkPreviewHtml({
      title: 'T',
      url: 'https://links.example.com/t',
      type: 'website',
    });
    expect(html).not.toContain('og:description');
    expect(html).not.toContain('twitter:description');
    expect(html).not.toContain('og:site_name');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('Open file');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  it('an image without a size gets no width and height tags', () => {
    const html = renderLinkPreviewHtml({
      title: 'T',
      url: 'https://links.example.com/t',
      type: 'website',
      image: { url: 'https://assets.example.com/a.jpg', alt: 'T' },
    });
    expect(html).toContain('og:image"');
    expect(html).not.toContain('og:image:width');
  });

  it.each(hostile)('never lets %j leave its attribute or element', text => {
    const html = renderLinkPreviewHtml(doc(text, text));
    const escaped = escapeHtml(text);
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${escaped}">`);
    expect(html).toContain(`<h1>${escaped}</h1>`);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('evil.example/x.png">');
    // One element per tag line: the count of <meta is fixed by the fields set
    expect(html.match(/<meta /g)?.length).toBe(
      renderLinkPreviewHtml(doc('a', 'b')).match(/<meta /g)?.length,
    );
    expect(html).toContain('content="https://links.example.com/doc?x=&quot;y&quot;"');
  });

  it('stays far below 100 KB at the longest values', () => {
    const html = renderLinkPreviewHtml({
      ...doc('"'.repeat(120), '&'.repeat(240)),
      image: {
        url: `https://assets.example.com/${'%22'.repeat(1024)}`,
        width: 1,
        height: 1,
        alt: '"'.repeat(120),
      },
      video: {
        url: `https://files.example.com/${'%22'.repeat(1024)}`,
        type: 'video/mp4',
        width: 7680,
        height: 7680,
      },
      fileUrl: `https://files.example.com/${'%22'.repeat(1024)}`,
    });
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(100 * 1024);
    expect(html).toContain('<meta property="og:video:secure_url"');
  });
});
