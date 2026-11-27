/**
 * The link-preview document (v1.48.0): a small HTML page of Open Graph and
 * Twitter Card tags, returned by `handleR2` only to recognised link-preview
 * fetchers. Pure: it renders the data it is given, nothing else.
 *
 * Every value goes through the one escaper (`escapeHtml`) and sits in a
 * double-quoted attribute or in element text, so a title or description can
 * never leave its attribute or element. The tags come first in `<head>`
 * (`<meta charset>` first of all), because several fetchers read only the
 * start of the document; the whole page stays far below the 100 KB some
 * fetchers read (bounded by the 120 and 240 character limits and the 1,024
 * character key). No script, no style, no external resource.
 */

import { escapeHtml } from './html-escape';
import type { LinkPreviewDocument } from './link-preview';

function meta(attribute: 'property' | 'name', key: string, value: string | number): string {
  return `<meta ${attribute}="${key}" content="${escapeHtml(String(value))}">`;
}

/** The preview document as HTML. */
export function renderLinkPreviewHtml(preview: LinkPreviewDocument): string {
  const tags: string[] = [
    '<meta charset="utf-8">',
    `<title>${escapeHtml(preview.title)}</title>`,
    meta('property', 'og:title', preview.title),
  ];
  if (preview.description !== undefined) {
    tags.push(meta('property', 'og:description', preview.description));
  }
  tags.push(meta('property', 'og:url', preview.url));
  if (preview.siteName !== undefined) tags.push(meta('property', 'og:site_name', preview.siteName));
  tags.push(meta('property', 'og:type', preview.type));
  if (preview.image) {
    tags.push(meta('property', 'og:image', preview.image.url));
    if (preview.image.width !== undefined && preview.image.height !== undefined) {
      tags.push(meta('property', 'og:image:width', preview.image.width));
      tags.push(meta('property', 'og:image:height', preview.image.height));
    }
    tags.push(meta('property', 'og:image:alt', preview.image.alt));
  }
  if (preview.video) {
    tags.push(meta('property', 'og:video', preview.video.url));
    tags.push(meta('property', 'og:video:secure_url', preview.video.url));
    tags.push(meta('property', 'og:video:type', preview.video.type));
    tags.push(meta('property', 'og:video:width', preview.video.width));
    tags.push(meta('property', 'og:video:height', preview.video.height));
  }
  tags.push(meta('name', 'twitter:card', preview.image ? 'summary_large_image' : 'summary'));
  tags.push(meta('name', 'twitter:title', preview.title));
  if (preview.description !== undefined) {
    tags.push(meta('name', 'twitter:description', preview.description));
  }
  if (preview.image) tags.push(meta('name', 'twitter:image', preview.image.url));
  if (preview.video) {
    tags.push(meta('name', 'twitter:player:stream', preview.video.url));
    tags.push(meta('name', 'twitter:player:stream:content_type', preview.video.type));
  }
  tags.push('<meta name="robots" content="noindex, nofollow">');
  tags.push('<meta name="viewport" content="width=device-width, initial-scale=1">');

  const link = preview.fileUrl
    ? `<p><a href="${escapeHtml(preview.fileUrl)}">Open file</a></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
${tags.join('\n')}
</head>
<body><h1>${escapeHtml(preview.title)}</h1>${link}</body>
</html>
`;
}
