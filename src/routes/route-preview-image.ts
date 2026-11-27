/**
 * The preview image of the route write paths (v1.48.0): when a write names a
 * preview image, the Worker reads it (one `get`) through the R2 binding and
 * requires it to exist, to be a JPEG or PNG by its own bytes and to be at
 * most PREVIEW_IMAGE_MAX_BYTES, and reads its pixel size from its header.
 * That size is what the route stores (`previewImageWidth`/`Height`); a
 * client-supplied size never reaches KV (the write schemas do not carry it).
 *
 * No outbound fetch: the image is read from the bucket, never by URL. The
 * admin API has one key, so the only bucket rule is the preview rules' own:
 * the bucket must have a custom domain (`isPreviewImageBucket`). Refusals are
 * fixed texts naming no key.
 *
 * Also the one check that an object in use as a preview image (a route's, or
 * a domain's default) is never replaced, deleted, renamed or moved through
 * the API ({@link checkPreviewImageNotInUse}).
 *
 * Imported by admin.ts, storage.ts and the R2 event consumer; it must not
 * import either route module.
 */

import {
  isPreviewImageBucket,
  PREVIEW_DEFAULT_IMAGES,
  PREVIEW_IMAGE_DIMENSION_MAX,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_KB,
  type PreviewDefaultImages,
} from '@bifrost/shared';
import type { PreviewImageSize } from '../kv/route-preview';
import {
  type KVRouteConfigWithDomain,
  matchRoutesByR2Target,
  type R2TargetRoute,
  scanRoutesByKey,
} from '../kv/routes';
import { type Bindings, BUCKET_BINDINGS, isValidR2Bucket } from '../types';
import { type ImageReading, type ImageRefusalReason, readImage } from '../utils/image-size';
import { validateR2Key } from '../utils/path-validation';

export const PREVIEW_IMAGE_KEY_INVALID = 'The preview image key is not a valid R2 key';
export const PREVIEW_IMAGE_NOT_FOUND = 'The preview image was not found in its bucket';
export const PREVIEW_IMAGE_TOO_LARGE = `The preview image must be at most ${PREVIEW_IMAGE_MAX_KB} KB (${PREVIEW_IMAGE_MAX_BYTES.toLocaleString('en-GB')} bytes)`;
export const PREVIEW_IMAGE_NOT_IMAGE = 'The preview image must be a JPEG or PNG file';
export const PREVIEW_IMAGE_TOO_MANY_PIXELS = `The preview image must be at most ${PREVIEW_IMAGE_DIMENSION_MAX.toLocaleString('en-GB')} pixels on each side`;
export const PREVIEW_IMAGE_UNSUPPORTED_JPEG =
  'The preview image is a JPEG with an unsupported layout: save it as a standard baseline or progressive JPEG, or as a PNG';
export const PREVIEW_IMAGE_UNAVAILABLE = 'The preview image bucket is not available';

/** The answer to each reason the image reader gives. */
const READING_REFUSALS: Record<ImageRefusalReason, string> = {
  'not-image': PREVIEW_IMAGE_NOT_IMAGE,
  'too-large': PREVIEW_IMAGE_TOO_MANY_PIXELS,
  'unsupported-jpeg': PREVIEW_IMAGE_UNSUPPORTED_JPEG,
};

/** The refusal of a preview image: a fixed text, answered as a 400. */
export interface PreviewImageRefusal {
  error: string;
}

const refuse = (error: string): PreviewImageRefusal => ({ error });

/**
 * The pixel size of the preview image `key` in `bucket`, or the refusal. An
 * R2 error is thrown unchanged (the error handler answers it without its
 * message).
 */
export async function measurePreviewImage(
  env: Bindings,
  bucket: string,
  key: string,
): Promise<PreviewImageSize | PreviewImageRefusal> {
  const validation = validateR2Key(key);
  if (!validation.valid) return refuse(PREVIEW_IMAGE_KEY_INVALID);
  if (!isValidR2Bucket(bucket) || !isPreviewImageBucket(bucket)) {
    return refuse(PREVIEW_IMAGE_UNAVAILABLE);
  }
  const binding = env[BUCKET_BINDINGS[bucket]];
  if (!binding) return refuse(PREVIEW_IMAGE_UNAVAILABLE);

  const size = await measureStoredImage(binding, key);
  if (size === 'missing') return refuse(PREVIEW_IMAGE_NOT_FOUND);
  if (size === 'too-large-file') return refuse(PREVIEW_IMAGE_TOO_LARGE);
  if ('reason' in size) return refuse(READING_REFUSALS[size.reason]);
  return { previewImageWidth: size.width, previewImageHeight: size.height };
}

/**
 * The pixel size of the object `key` in `binding`, read as a preview image
 * is (one `get`, which gives the size before any of the body is consumed; a
 * body over PREVIEW_IMAGE_MAX_BYTES is cancelled unread), or why there is
 * none. With `etag` (the R2 event consumer) the read is conditional on that
 * ETag (`onlyIf.etagMatches`): a later object at the key answers `superseded`
 * without its body. An R2 error is thrown unchanged.
 */
export function measureStoredImage(
  binding: R2Bucket,
  key: string,
): Promise<ImageReading | 'missing' | 'too-large-file'>;
export function measureStoredImage(
  binding: R2Bucket,
  key: string,
  etag: string,
): Promise<ImageReading | 'missing' | 'too-large-file' | 'superseded'>;
export async function measureStoredImage(
  binding: R2Bucket,
  key: string,
  etag?: string,
): Promise<ImageReading | 'missing' | 'too-large-file' | 'superseded'> {
  const object =
    etag === undefined
      ? await binding.get(key)
      : await binding.get(key, { onlyIf: { etagMatches: etag } });
  if (!object) return 'missing';
  // A failed condition gives the object's metadata without its body
  if (!isObjectBody(object)) return 'superseded';
  if (object.size > PREVIEW_IMAGE_MAX_BYTES) {
    await object.body.cancel().catch(() => {});
    return 'too-large-file';
  }
  return readImage(new Uint8Array(await object.arrayBuffer()));
}

/** Whether a conditional `get` gave the body (its condition held). */
function isObjectBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return 'body' in object && object.body !== undefined;
}

/**
 * The image size a write should store, for a route whose effective record
 * (after the patch) is `effective`: measured when the write names an image
 * (`touched`: a create with an image, or a patch that sets the image bucket
 * or key) and the effective record still has one; `undefined` when nothing
 * is to be measured. A refusal is returned for the caller to answer as a 400.
 */
export async function previewImageSizeForWrite(
  env: Bindings,
  effective: { previewImageBucket?: string | undefined; previewImageKey?: string | undefined },
  touched: boolean,
): Promise<PreviewImageSize | PreviewImageRefusal | undefined> {
  if (!touched || !effective.previewImageBucket || !effective.previewImageKey) return undefined;
  return measurePreviewImage(env, effective.previewImageBucket, effective.previewImageKey);
}

/** Whether a patch names the preview image (sets or clears its bucket or key). */
export function patchTouchesPreviewImage(patch: {
  previewImageBucket?: string | undefined;
  previewImageKey?: string | undefined;
}): boolean {
  return patch.previewImageBucket !== undefined || patch.previewImageKey !== undefined;
}

/** Whether `value` is a refusal rather than a size. */
export function isPreviewImageRefusal(
  value: PreviewImageSize | PreviewImageRefusal | undefined,
): value is PreviewImageRefusal {
  return value !== undefined && 'error' in value;
}

/**
 * The storage writes that would leave a preview image stale or missing, and
 * so are refused while a route or a domain default names the object: an
 * overwrite (the route stores the size measured when it named the image, and
 * nothing measures a replacement), a delete, and a rename or move of the
 * source object (both delete it).
 */
export type PreviewImageWrite = 'replace' | 'delete' | 'rename' | 'move';

/** The refusal's fixed sentence for each write when a route uses the object. */
export const PREVIEW_IMAGE_IN_USE_TEXT: Readonly<Record<PreviewImageWrite, string>> = {
  replace:
    'This object is the link-preview image of a route, so it cannot be replaced: upload the new image under a new key and point the route at it.',
  delete:
    'This object is the link-preview image of a route, so it cannot be deleted: point the route at another image, or remove its preview image, first.',
  rename:
    'This object is the link-preview image of a route, so it cannot be renamed: upload a copy under the new key, point the route at it, then delete this one.',
  move: 'This object is the link-preview image of a route, so it cannot be moved: upload a copy to the other bucket, point the route at it, then delete this one.',
};

/** The sentence for each write when only domain defaults use the object. */
export const PREVIEW_DEFAULT_IMAGE_IN_USE_TEXT: Readonly<Record<PreviewImageWrite, string>> = {
  replace:
    "This object is a domain's default link-preview image, so it cannot be replaced: upload the new image under a new key and point the default at it.",
  delete:
    "This object is a domain's default link-preview image, so it cannot be deleted: point the default at another image first.",
  rename:
    "This object is a domain's default link-preview image, so it cannot be renamed: upload a copy under the new key, point the default at it, then delete this one.",
  move: "This object is a domain's default link-preview image, so it cannot be moved: upload a copy to the other bucket, point the default at it, then delete this one.",
};

/** The refusal's log line for each write: a fixed text, never a key. */
const PREVIEW_IMAGE_IN_USE_LOG: Readonly<Record<PreviewImageWrite, string>> = {
  replace: 'Upload refused: the object is a link-preview image (of a route or a domain default)',
  delete: 'Delete refused: the object is a link-preview image (of a route or a domain default)',
  rename: 'Rename refused: the object is a link-preview image (of a route or a domain default)',
  move: 'Move refused: the object is a link-preview image (of a route or a domain default)',
};

/**
 * The refusal's text: the fixed sentence of the write, then each route that
 * uses the object (domain and path, sorted), then each domain whose default
 * card image it is. The admin API has one key, so every route is named:
 * the caller can list them all through `GET /api/routes/by-target`.
 */
export function previewImageInUseMessage(
  routes: ReadonlyArray<{ domain: string; path: string }>,
  defaultDomains: readonly string[],
  write: PreviewImageWrite,
): string {
  const names = routes.map(route => `${route.domain}${route.path}`).toSorted();
  const routeCount = names.length;
  for (const domain of defaultDomains.toSorted()) names.push(`the default card image of ${domain}`);
  const opening =
    routeCount === 0 && defaultDomains.length > 0
      ? PREVIEW_DEFAULT_IMAGE_IN_USE_TEXT[write]
      : PREVIEW_IMAGE_IN_USE_TEXT[write];
  const last = names.pop();
  if (last === undefined) return opening;
  const list = names.length > 0 ? `${names.join(', ')} and ${last}` : last;
  return `${opening} Used by ${list}.`;
}

/**
 * The domains whose default card image (`PREVIEW_DEFAULT_IMAGES`) is the
 * object at `key` in `bucket`. An entry counts when it names a preview image
 * bucket and the same key; its key and size are not checked further, so an
 * entry a card would skip (`isServableImageRef`) still protects that object,
 * which is stricter and harmless. `defaults` is the shipped map; a test may
 * pass its own.
 */
export function defaultImageDomainsUsingObject(
  bucket: string,
  key: string,
  defaults: PreviewDefaultImages = PREVIEW_DEFAULT_IMAGES,
): string[] {
  return Object.entries(defaults)
    .filter(
      ([, ref]) =>
        !!ref && ref.bucket === bucket && isPreviewImageBucket(ref.bucket) && ref.key === key,
    )
    .map(([domain]) => domain);
}

/**
 * Whether `bucket` can hold a route's preview image: one of the buckets a
 * preview write accepts (`isPreviewImageBucket`, a bucket with a custom
 * domain). Only a write there is checked, so only there does a route scan
 * that cannot complete refuse it.
 */
export function mayHoldPreviewImage(bucket: string): boolean {
  return isPreviewImageBucket(bucket);
}

/** The routes that use one R2 object, from one scan. */
export interface ObjectRouteUses {
  /** Routes that show the object as their link-preview image */
  previewImage: R2TargetRoute[];
  /**
   * Routes that serve the object: the set the cache purge would list itself
   * (`purgeR2CacheForObject`), passed to it so a write scans the route
   * namespace once
   */
  serving: R2TargetRoute[];
}

/**
 * {@link routesUsingObject} over routes already scanned (`scanRoutesByKey`):
 * the R2 event consumer scans once per batch. Routes are named by the
 * domain and path of their KV key.
 */
export function objectRouteUses(
  allRoutes: readonly KVRouteConfigWithDomain[],
  bucket: string,
  key: string,
): ObjectRouteUses {
  const routes = matchRoutesByR2Target(allRoutes, bucket, key);
  return {
    // The flag `matchRoutesByR2Target` sets: the same rule as Storage's
    // associated routes, so the two always agree
    previewImage: routes.filter(route => route.previewImage === true),
    serving: routes.filter(route => route.usage === 'file'),
  };
}

/**
 * The routes that use the object at `key` in `bucket`, from one scan of the
 * route namespace (`scanRoutesByKey`, one KV list per 1,000 keys and one bulk
 * read per 100 route keys). A KV failure is thrown: a caller that cannot list
 * the routes writes nothing.
 */
export async function routesUsingObject(
  env: Pick<Bindings, 'ROUTES'>,
  bucket: string,
  key: string,
): Promise<ObjectRouteUses> {
  return objectRouteUses(await scanRoutesByKey(env.ROUTES), bucket, key);
}

/**
 * The body of the 409 refusal (`STORE_PREVIEW_IMAGE_IN_USE`): the caller
 * answers it with `c.json(refusal, 409)`, never by throwing, so the error
 * handler never logs its text.
 */
export interface PreviewImageInUseRefusal {
  success: false;
  error: 'STORE_PREVIEW_IMAGE_IN_USE';
  message: string;
}

/**
 * The preview-image check of a storage write (replace, delete, and the
 * source of a rename or move): the ONE place that decides whether the object
 * at `key` in `bucket` is in use as a preview image. The uses are the routes
 * that name it (`routesUsingObject`) and the domains whose default card image
 * it is (`defaultImageDomainsUsingObject`).
 *
 * Runs only in a bucket that can hold a preview image (`mayHoldPreviewImage`):
 * elsewhere it answers `{}` without a scan (no refusal, no serving routes, so
 * the purge lists the routes itself after the write, degrading quietly on a
 * KV failure as before). There a scan that cannot complete is thrown, so the
 * write fails closed (500) and changes nothing. In use: the 409 refusal's
 * body, naming the routes and domain defaults, and one log line with the
 * bucket and the code only. Not in use: the routes serving the object, for
 * the cache purge (one scan per write). Call it after the key and existence
 * checks.
 */
export async function checkPreviewImageNotInUse(
  env: Pick<Bindings, 'ROUTES'>,
  write: PreviewImageWrite,
  bucket: string,
  key: string,
): Promise<
  { refusal: PreviewImageInUseRefusal } | { refusal?: undefined; serving?: R2TargetRoute[] }
> {
  if (!mayHoldPreviewImage(bucket)) return {};
  const uses = await routesUsingObject(env, bucket, key);
  const defaultUses = defaultImageDomainsUsingObject(bucket, key);
  if (uses.previewImage.length === 0 && defaultUses.length === 0) {
    return { serving: uses.serving };
  }
  // The bucket and the code only: never the key or a route's path
  console.warn(
    JSON.stringify({
      level: 'warn',
      message: PREVIEW_IMAGE_IN_USE_LOG[write],
      error: 'STORE_PREVIEW_IMAGE_IN_USE',
      bucket,
    }),
  );
  return {
    refusal: {
      success: false,
      error: 'STORE_PREVIEW_IMAGE_IN_USE',
      message: previewImageInUseMessage(uses.previewImage, defaultUses, write),
    },
  };
}
