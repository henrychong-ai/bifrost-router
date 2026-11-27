/**
 * What a link-preview fetcher is told about a file route (v1.48.0): the data
 * of the preview document, built from the route's stored preview fields and
 * the request. Rendered by `renderLinkPreviewHtml` (link-preview-html.ts)
 * for the serving branch in `handleR2`, and read by the dashboard's own
 * link-preview panel (`ownHostResolver`, og-own-host.ts), so the panel shows
 * what fetchers receive.
 *
 * Addresses: the image, the "Open file" link and the video tags point at the
 * bucket's R2 custom domain (`bucketCustomDomainUrl`), never at the short
 * link, which would hand the fetcher this document again. A bucket with no
 * custom domain gives no "Open file" link and no video tags.
 */

import {
  bucketCustomDomainUrl,
  isServableR2Key,
  PREVIEW_DEFAULT_IMAGES,
  type PreviewDefaultImages,
  previewCard,
  type ServablePreview,
  servablePreview,
} from '@bifrost/shared';
import type { KVRouteConfig } from '../types';

/** The data of one preview document. */
export interface LinkPreviewDocument {
  title: string;
  description?: string;
  /** The short link itself: scheme, host and path, no query. */
  url: string;
  siteName?: string;
  type: 'website' | 'video.other';
  image?: { url: string; width?: number; height?: number; alt: string };
  video?: { url: string; type: 'video/mp4' | 'video/webm'; width: number; height: number };
  /** The file's own public address (its bucket's custom domain), when it has one. */
  fileUrl?: string;
}

const PLAYABLE_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;

/**
 * The preview `route` may serve under today's rules, or null (no card):
 * `servablePreview` with the write path's own R2 key rule (`isServableR2Key`,
 * the check `validateR2Key` makes, without its log line).
 */
export function routeServablePreview(route: KVRouteConfig): ServablePreview | null {
  return servablePreview(route as unknown as Record<string, unknown>, isServableR2Key);
}

/**
 * The preview document for a route's validated `preview`, answering
 * `requestUrl`, whose file lives in `fileBucket` at `servedKey` with content
 * type `contentType`. Its title, description, site name and image are the
 * shared card decision (`previewCard`: the route's own image, else the
 * domain's default in `defaults`, else none), so the dashboard's live card
 * decides as this does. `defaults` is the shipped map; a test may pass its
 * own.
 */
export function buildLinkPreviewDocument(
  preview: ServablePreview,
  fileBucket: string,
  requestUrl: URL,
  servedKey: string,
  contentType: string,
  defaults: PreviewDefaultImages = PREVIEW_DEFAULT_IMAGES,
): LinkPreviewDocument {
  const host = requestUrl.hostname;
  const fileUrl = bucketCustomDomainUrl(fileBucket, servedKey, host) ?? undefined;
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const card = previewCard(preview, host, defaults);

  const document: LinkPreviewDocument = {
    title: card.title,
    url: `${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}`,
    type: mediaType.startsWith('video/') ? 'video.other' : 'website',
  };
  if (card.description) document.description = card.description;
  if (card.siteName) document.siteName = card.siteName;
  if (fileUrl) document.fileUrl = fileUrl;
  if (card.image) document.image = card.image;

  const playable = PLAYABLE_VIDEO_TYPES.find(type => type === mediaType);
  if (playable && fileUrl && preview.video) {
    document.video = { url: fileUrl, type: playable, ...preview.video };
  }
  return document;
}
