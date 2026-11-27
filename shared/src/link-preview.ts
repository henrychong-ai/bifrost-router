/**
 * Link previews for file routes (v1.48.0, ported from a sibling deployment of
 * the same design and adapted).
 *
 * An `r2` route may carry optional preview details: a title, a description,
 * an image (a JPEG or PNG in a bucket that has an R2 custom domain) and, for
 * a video file, the playback size. The Worker returns them as Open Graph and
 * Twitter Card tags ONLY to recognised link-preview fetchers
 * (`src/utils/preview-fetcher.ts`); everyone else receives the file exactly
 * as before. The feature is opt-in per route: nothing changes until a route
 * has a `previewTitle`.
 *
 * Operator configuration, all shipped empty so a fresh fork changes nothing:
 * - `R2_BUCKET_CUSTOM_DOMAINS` (`types.ts`): only a bucket with a custom
 *   domain can hold a preview image ({@link previewImageBuckets}). Empty, a
 *   card is text only.
 * - {@link PREVIEW_SITE_NAMES}: the `og:site_name` per supported domain.
 * - {@link PREVIEW_DEFAULT_IMAGES}: the image a card shows when its route has
 *   none.
 * `shared/src/link-preview.test.ts` forces every supported domain to be
 * classified in both maps, so a new domain cannot ship undecided.
 *
 * The fields are FLAT (the stored-route guard classifies primitives only) and
 * all optional; an absent field means no preview, so no stored record needs a
 * migration. This module is the one source of the limits, the sanitiser, the
 * field lists and the write-time rules, shared by the Worker, the MCP server
 * and the dashboard.
 */

import { normaliseNewlines, stripControlChars } from './comment.js';
import { isServableR2Key } from './r2-key.js';
import { hasLoneSurrogate } from './text-scan.js';
import {
  encodeR2KeyAsPath,
  getZoneIdForDomain,
  R2_BUCKET_CUSTOM_DOMAINS,
  R2_BUCKETS,
  type R2BucketName,
} from './types.js';

/** Longest preview title, after sanitising. */
export const PREVIEW_TITLE_MAX_LENGTH = 120;
/** Longest preview description, after sanitising. */
export const PREVIEW_DESCRIPTION_MAX_LENGTH = 240;
/**
 * Largest preview image, in bytes: 600,000 (decimal 600 KB, the stricter
 * reading). WhatsApp documents images "under 600 KB"; the other platforms
 * accept larger ones, so this one bound serves all.
 */
export const PREVIEW_IMAGE_MAX_BYTES = 600_000;
/** The same limit in decimal kilobytes, as the field help and errors state it. */
export const PREVIEW_IMAGE_MAX_KB = PREVIEW_IMAGE_MAX_BYTES / 1000;
/** Largest accepted R2 key for the preview image, in characters (R2: 1,024 bytes). */
export const PREVIEW_IMAGE_KEY_MAX_LENGTH = 1024;
/** Largest image width or height accepted from an image header. */
export const PREVIEW_IMAGE_DIMENSION_MAX = 16_384;
/** Largest video playback width or height a route may declare (8K). */
export const PREVIEW_VIDEO_DIMENSION_MAX = 7680;

/** The preview text fields (empty or whitespace-only text drops the field). */
export const PREVIEW_TEXT_FIELDS = [
  'previewTitle',
  'previewDescription',
  'previewImageBucket',
  'previewImageKey',
] as const;

/** The preview dimension fields: positive whole numbers. */
export const PREVIEW_DIMENSION_FIELDS = [
  'previewImageWidth',
  'previewImageHeight',
  'previewVideoWidth',
  'previewVideoHeight',
] as const;

/** Every preview field, in display order. */
export const PREVIEW_FIELDS = [...PREVIEW_TEXT_FIELDS, ...PREVIEW_DIMENSION_FIELDS] as const;

export type PreviewField = (typeof PREVIEW_FIELDS)[number];

/** The preview fields of a stored route (all optional; absent = no preview). */
export interface RoutePreviewFields {
  previewTitle?: string | undefined;
  previewDescription?: string | undefined;
  previewImageBucket?: string | undefined;
  previewImageKey?: string | undefined;
  /** Pixel width read from the image's header when the route was saved. */
  previewImageWidth?: number | undefined;
  /** Pixel height read from the image's header when the route was saved. */
  previewImageHeight?: number | undefined;
  previewVideoWidth?: number | undefined;
  previewVideoHeight?: number | undefined;
}

/** The custom domains configured for `bucket` (own keys only), or none. */
function customDomainsOf(bucket: string): readonly string[] {
  if (!Object.hasOwn(R2_BUCKET_CUSTOM_DOMAINS, bucket)) return [];
  const domains = R2_BUCKET_CUSTOM_DOMAINS[bucket];
  return Array.isArray(domains) ? domains : [];
}

/**
 * The buckets a preview image may come from: file buckets that have an R2
 * custom domain (`R2_BUCKET_CUSTOM_DOMAINS`), so the image has a public
 * address outside the Worker (the Worker's `Cross-Origin-Resource-Policy:
 * same-origin` would otherwise hide it from the dashboard's own preview, and
 * a fetcher must not be sent back to a short link). Read from the map each
 * call: with the template's empty map there are none.
 */
export function previewImageBuckets(): R2BucketName[] {
  return R2_BUCKETS.filter(bucket => customDomainsOf(bucket).length > 0);
}

/** Whether `bucket` may hold a route's preview image. */
export function isPreviewImageBucket(bucket: string): boolean {
  return (previewImageBuckets() as readonly string[]).includes(bucket);
}

/**
 * Sanitise preview text like a comment (`sanitizeComment`): CRLF and CR become
 * LF, C0 control characters other than tab and newline and DEL are dropped,
 * and the result is trimmed. A single-line field (the title) also turns every
 * tab and newline into a space. Returns null for nullish, empty or
 * whitespace-only input, which a write treats as "no such field".
 */
export function sanitizePreviewText(
  raw: string | null | undefined,
  options: { singleLine: boolean },
): string | null {
  if (raw == null) return null;
  const kept = stripControlChars(normaliseNewlines(raw));
  const trimmed = (options.singleLine ? kept.replace(/[\t\n]/g, ' ') : kept).trim();
  return trimmed === '' ? null : trimmed;
}

/** The stored form of a preview title, or null when it is empty. */
export const sanitizePreviewTitle = (raw: string | null | undefined): string | null =>
  sanitizePreviewText(raw, { singleLine: true });

/** The stored form of a preview description, or null when it is empty. */
export const sanitizePreviewDescription = (raw: string | null | undefined): string | null =>
  sanitizePreviewText(raw, { singleLine: false });

/** Whether a preview field holds a value (absent, null and '' do not). */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Whether `route` carries any preview field. */
export function hasPreviewFields(route: Partial<Record<PreviewField, unknown>>): boolean {
  return PREVIEW_FIELDS.some(field => isSet(route[field]));
}

/** Whether a route path is a wildcard (`/docs/*`): it serves many request paths. */
export function isWildcardRoutePath(path: string): boolean {
  return path.includes('*');
}

/** The refusal of preview details on anything but an `r2` route. */
export const PREVIEW_R2_ONLY_ERROR = 'Link preview details apply only to r2 routes';
/** The refusal of preview details on a wildcard route. */
export const PREVIEW_WILDCARD_ERROR =
  'Link preview details apply only to routes that serve one file, never to a wildcard route';
/** The refusal of preview details without a title. */
export const PREVIEW_TITLE_REQUIRED_ERROR =
  'A link preview needs a title (previewTitle) when any other preview field is set';
/** The refusal of half an image reference. */
export const PREVIEW_IMAGE_PAIR_ERROR =
  'A preview image needs both previewImageBucket and previewImageKey';
/** The refusal of half a video size. */
export const PREVIEW_VIDEO_PAIR_ERROR =
  'A preview video size needs both previewVideoWidth and previewVideoHeight';

/**
 * The refusal of an image bucket with no public address: names the buckets
 * that may hold one now, or says that none is configured.
 */
export function previewImageBucketError(): string {
  const buckets = previewImageBuckets();
  return buckets.length > 0
    ? `A preview image must be in a bucket that has a custom domain (one of: ${buckets.join(', ')})`
    : 'A preview image must be in a bucket that has a custom domain, and none is configured (R2_BUCKET_CUSTOM_DOMAINS)';
}

/** The fields {@link previewRuleError} examines. */
export interface PreviewRuleInput extends Partial<Record<PreviewField, unknown>> {
  type?: string | undefined;
  path?: string | undefined;
}

/**
 * The write-time preview rules for a route (create, or the effective record
 * after an update): the refusal text, or null. A route with no preview field
 * passes. Fixed texts: they name no path, key or value.
 *
 *  1. Preview details only on `r2` routes.
 *  2. Only on a route that serves one file: never a wildcard route.
 *  3. `previewTitle` is required when any other preview field is set.
 *  4. An image is a bucket AND a key, in a bucket that has a custom domain.
 *  5. A video size is a width AND a height.
 */
export function previewRuleError(route: PreviewRuleInput): string | null {
  if (!hasPreviewFields(route)) return null;
  if (route.type !== 'r2') return PREVIEW_R2_ONLY_ERROR;
  if (typeof route.path === 'string' && isWildcardRoutePath(route.path)) {
    return PREVIEW_WILDCARD_ERROR;
  }
  if (!isSet(route.previewTitle)) return PREVIEW_TITLE_REQUIRED_ERROR;
  const hasBucket = isSet(route.previewImageBucket);
  if (hasBucket !== isSet(route.previewImageKey)) return PREVIEW_IMAGE_PAIR_ERROR;
  if (hasBucket && !isPreviewImageBucket(String(route.previewImageBucket))) {
    return previewImageBucketError();
  }
  if (isSet(route.previewVideoWidth) !== isSet(route.previewVideoHeight)) {
    return PREVIEW_VIDEO_PAIR_ERROR;
  }
  return null;
}

const isDimension = (value: unknown, max: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

/** A route's preview as it may be served: every part validated under today's rules. */
export interface ServablePreview {
  title: string;
  description?: string;
  image?: { bucket: string; key: string; width: number; height: number };
  video?: { width: number; height: number };
}

/**
 * The preview a STORED route may serve, or null for none. Stored records are
 * read by type only (the stored-route guard), so a record written under other
 * rules, or later changed out of band, never becomes unreadable: this is
 * where today's rules apply, at serve time. A title is required; every
 * present part must then pass: the title and description sanitised and
 * within their caps; the image as an allowed bucket AND a key the writer
 * would accept (`isValidKey`, the side-effect-free form of the write path's
 * R2 key check), with its measured width and height (1 to
 * PREVIEW_IMAGE_DIMENSION_MAX); a video size as both or neither, in range.
 * Any part out of shape means no card at all: the file is served as usual,
 * and the next save fixes or clears the preview.
 */
export function servablePreview(
  route: Record<string, unknown>,
  isValidKey: (key: string) => boolean,
): ServablePreview | null {
  const title = route['previewTitle'];
  if (
    typeof title !== 'string' ||
    title.length > PREVIEW_TITLE_MAX_LENGTH ||
    sanitizePreviewTitle(title) !== title
  ) {
    return null;
  }
  const preview: ServablePreview = { title };

  const description = route['previewDescription'];
  if (description != null) {
    if (
      typeof description !== 'string' ||
      description.length > PREVIEW_DESCRIPTION_MAX_LENGTH ||
      sanitizePreviewDescription(description) !== description
    ) {
      return null;
    }
    preview.description = description;
  }

  const bucket = route['previewImageBucket'];
  const key = route['previewImageKey'];
  const width = route['previewImageWidth'];
  const height = route['previewImageHeight'];
  // A measured size counts as part of the image: one without a reference is
  // no shape a write produces
  if (bucket != null || key != null || width != null || height != null) {
    if (
      typeof bucket !== 'string' ||
      !isPreviewImageBucket(bucket) ||
      typeof key !== 'string' ||
      key.length > PREVIEW_IMAGE_KEY_MAX_LENGTH ||
      // A lone surrogate has no UTF-8 form: its address could not be built
      hasLoneSurrogate(key) ||
      !isValidKey(key) ||
      !isDimension(width, PREVIEW_IMAGE_DIMENSION_MAX) ||
      !isDimension(height, PREVIEW_IMAGE_DIMENSION_MAX)
    ) {
      return null;
    }
    preview.image = { bucket, key, width: width as number, height: height as number };
  }

  const videoWidth = route['previewVideoWidth'];
  const videoHeight = route['previewVideoHeight'];
  if (videoWidth != null || videoHeight != null) {
    if (
      !isDimension(videoWidth, PREVIEW_VIDEO_DIMENSION_MAX) ||
      !isDimension(videoHeight, PREVIEW_VIDEO_DIMENSION_MAX)
    ) {
      return null;
    }
    preview.video = { width: videoWidth as number, height: videoHeight as number };
  }
  return preview;
}

/**
 * Whether a file may be answered with a card at all: an `r2` route that
 * serves one file (not a wildcard route) and a file that is not an image (an
 * image link previews as the image itself, and another page may use it as its
 * own `og:image`). The serving branch and the dashboard's own-host preview
 * both decide with this, so the panel never shows a card the link does not
 * serve.
 */
export function isCardEligibleFile(
  route: { type?: string | undefined; path?: string | undefined },
  contentType: string,
): boolean {
  return (
    route.type === 'r2' &&
    !(typeof route.path === 'string' && isWildcardRoutePath(route.path)) &&
    !contentType.trim().toLowerCase().startsWith('image/')
  );
}

/**
 * The public address of `key` in `bucket` through the bucket's R2 custom
 * domain: among the bucket's custom domains, the one in the same Cloudflare
 * zone as `requestHost` (`CLOUDFLARE_ZONE_IDS`), else the first. Null when
 * the bucket has no custom domain.
 */
export function bucketCustomDomainUrl(
  bucket: string,
  key: string,
  requestHost: string,
): string | null {
  const domains = customDomainsOf(bucket);
  if (domains.length === 0) return null;
  const hostZone = getZoneIdForDomain(requestHost);
  const sameZone =
    hostZone === undefined
      ? undefined
      : domains.find(domain => getZoneIdForDomain(domain) === hostZone);
  return `https://${sameZone ?? domains[0]}/${encodeR2KeyAsPath(key)}`;
}

/**
 * `og:site_name` per supported domain: the site name each host carries, or
 * null for none. OPERATOR CONFIGURATION, shipped all null (no site name).
 * Every supported domain is classified here (`link-preview.test.ts`); a new
 * supported domain is added here too (AGENTS.md, "Adding a New Supported
 * Domain").
 */
export const PREVIEW_SITE_NAMES: Readonly<Record<string, string | null>> = {
  'example.com': null,
  'links.example.com': null,
  'bifrost.example.com': null,
  'secondary.example.net': null,
  'user1.example.com': null,
  'user2.example.com': null,
  'user3.example.com': null,
  'user4.example.com': null,
  'user5.example.com': null,
};

/** An image a card may show: an object in a preview image bucket, and its pixel size. */
export interface PreviewImageRef {
  bucket: string;
  key: string;
  width: number;
  height: number;
}

/**
 * The default image per supported domain: what a route with a title and no
 * image of its own shows, or null for none. OPERATOR CONFIGURATION, shipped
 * all null, so every card is text only unless its route names an image.
 * Every supported domain is classified here (`link-preview.test.ts`, which
 * also checks each image reference).
 *
 * An entry names a JPEG or PNG of at most PREVIEW_IMAGE_MAX_BYTES in one of
 * the preview image buckets, with its real pixel size (nothing measures it at
 * serve time). Adding one: README, "Link previews for file routes".
 */
export const PREVIEW_DEFAULT_IMAGES: Readonly<Record<string, PreviewImageRef | null>> = {
  'example.com': null,
  'links.example.com': null,
  'bifrost.example.com': null,
  'secondary.example.net': null,
  'user1.example.com': null,
  'user2.example.com': null,
  'user3.example.com': null,
  'user4.example.com': null,
  'user5.example.com': null,
};

/** A default-image map: the shipped one, or one a test supplies. */
export type PreviewDefaultImages = Readonly<Partial<Record<string, PreviewImageRef | null>>>;

/**
 * What a card is built from: a servable preview, or the dashboard's live
 * draft of one, whose route image has no size yet (the save measures it).
 */
export interface PreviewCardInput {
  title: string;
  description?: string | undefined;
  image?: { bucket: string; key: string; width?: number; height?: number } | undefined;
}

/**
 * Drop a measured image size that has no complete image reference (bucket
 * and key) beside it, in place. Every write does this (`normalizeNewPreview`
 * and `applyPreviewPatch` in src/kv/route-preview.ts), so the dashboard's
 * prediction of a save does it too: a legacy record with a title and an
 * orphaned size is served a text-only card after any save.
 */
export function dropOrphanPreviewImageSize(record: Record<string, unknown>): void {
  if (!record['previewImageBucket'] || !record['previewImageKey']) {
    delete record['previewImageWidth'];
    delete record['previewImageHeight'];
  }
}

/** The text and image a card shows. */
export interface PreviewCard {
  title: string;
  description?: string;
  siteName?: string;
  image?: { url: string; width?: number; height?: number; alt: string };
  /** Where the image comes from: the route's own, or its domain's default. */
  imageSource?: 'route' | 'default';
}

/**
 * Whether `ref` is an image a route could serve as its own: the route-image
 * rules of `servablePreview` (a preview image bucket, a key the writer
 * accepts with no lone surrogate, a measured size from 1 to the header
 * limit). A domain default is served only when it passes, and
 * `link-preview.test.ts` checks every shipped entry with it.
 */
export function isServableImageRef(ref: PreviewImageRef): boolean {
  const asRoute = {
    previewTitle: 'image check',
    previewImageBucket: ref.bucket,
    previewImageKey: ref.key,
    previewImageWidth: ref.width,
    previewImageHeight: ref.height,
  };
  return servablePreview(asRoute, isServableR2Key) !== null;
}

/** A per-domain entry by own key only (never an inherited `constructor`). */
function ownEntry<T>(map: Readonly<Partial<Record<string, T>>>, host: string): T | undefined {
  return Object.hasOwn(map, host) ? map[host] : undefined;
}

/**
 * The card for a validated `preview` answering on `host`: its title and
 * description, the site name of the host, and the image. The one decision of
 * the image, for the served document (`buildLinkPreviewDocument`), the
 * dashboard's saved-route panel (through that builder) and the route form's
 * live card:
 *
 *  1. The route's own image always wins.
 *  2. Else the host's default in `defaults`, when it is an image a route
 *     could serve (`isServableImageRef`); a bad entry is skipped, never served.
 *  3. Else no image: a text-only card.
 *
 * The image's address is its bucket's custom domain (`bucketCustomDomainUrl`)
 * and its alternative text the title. Only a preview that passed
 * `servablePreview` reaches here, so a route whose stored preview is out of
 * shape has no card at all and never falls back to the default.
 */
export function previewCard(
  preview: PreviewCardInput,
  host: string,
  defaults: PreviewDefaultImages,
): PreviewCard {
  const card: PreviewCard = { title: preview.title };
  if (preview.description) card.description = preview.description;
  const siteName = ownEntry(PREVIEW_SITE_NAMES, host);
  if (siteName) card.siteName = siteName;

  const fallback = ownEntry(defaults, host);
  const image = preview.image ?? (fallback && isServableImageRef(fallback) ? fallback : undefined);
  const url = image ? bucketCustomDomainUrl(image.bucket, image.key, host) : null;
  if (image && url) {
    card.image = { url, alt: preview.title };
    if (image.width !== undefined) card.image.width = image.width;
    if (image.height !== undefined) card.image.height = image.height;
    card.imageSource = preview.image ? 'route' : 'default';
  }
  return card;
}
