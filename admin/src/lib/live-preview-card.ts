import {
  dropOrphanPreviewImageSize,
  isCardEligibleFile,
  isServableR2Key,
  isWildcardRoutePath,
  PREVIEW_DEFAULT_IMAGES,
  type PreviewCard,
  type PreviewDefaultImages,
  previewCard,
  type RoutePreviewFields,
  sanitizePreviewDescription,
  sanitizePreviewTitle,
  servablePreview,
} from '@bifrost/shared';
import {
  PREVIEW_TITLE_NEEDED,
  parsePreviewDimension,
  previewFileContentType,
  previewFileIsImage,
  previewFormErrors,
  type RouteFormValues,
} from './route-patch';

/**
 * The route form's live link-preview card (v1.48.0): what a platform would
 * receive if the form were saved now. Decided with the Worker's own shared
 * functions, never a copy of their rules:
 *
 *  1. Nothing for a disabled route (the lookup skips it: no card, no file).
 *  2. `isCardEligibleFile`: the route can have a card at all (an r2 route
 *     serving one file, a file that is not an image), with the file's type
 *     judged as `previewFileIsImage` judges it; and a file the dashboard's
 *     read found missing has none (the Worker answers its 404).
 *  3. The form's own field errors (`previewFormErrors`): a save is blocked,
 *     so nothing is sent; the line shows the field's error text.
 *  4. `servablePreview` with the writer's key check (`isServableR2Key`) on
 *     the record the save would leave stored (`previewRecordIfSaved`).
 *  5. `previewCard` builds the card: the route's own image, else the
 *     domain's default (`PREVIEW_DEFAULT_IMAGES`), else text only.
 */

/**
 * The live card: the card a save would send, or why none would be.
 * `imageCheckedOnSave`: the card's image is a new one, which the save reads
 * from its bucket and refuses unless it exists and is a JPEG or PNG within
 * the size and pixel limits. `provisional`: the route's file has not been
 * confirmed to exist, and a fetcher gets the card only if it does.
 */
export type LivePreviewCard =
  | { send: true; card: PreviewCard; imageCheckedOnSave: boolean; provisional: boolean }
  | { send: false; reason: string };

/**
 * What the dashboard's read of the route's file found: `found`, `missing`
 * (a 404), or `unconfirmed` (no read yet, pending, or failed).
 */
export type PreviewFileStatus = 'found' | 'missing' | 'unconfirmed';

/**
 * The file status from the dashboard's read of the route's file: only a read
 * made for the form's current bucket and key (`settled`) counts; its data
 * means the file exists, a 404 that it does not, and anything else proves
 * neither.
 */
export function previewFileStatus(read: {
  settled: boolean;
  data: unknown;
  error: unknown;
}): PreviewFileStatus {
  if (!read.settled) return 'unconfirmed';
  if (read.data !== undefined) return 'found';
  const status =
    typeof read.error === 'object' && read.error !== null
      ? (read.error as { status?: unknown }).status
      : undefined;
  return status === 404 ? 'missing' : 'unconfirmed';
}

export const NO_CARD_DISABLED = 'This route is turned off: a disabled link serves nothing';
export const NO_CARD_FILE_MISSING =
  'The file was not found in its bucket when the dialog last checked it: a link to a missing file has no card';
export const NO_CARD_NOT_FILE = 'Only a file route can have a card';
export const NO_CARD_WILDCARD = 'A wildcard route serves many files, so it has no card';
export const NO_CARD_IMAGE_FILE =
  'This file is an image: a shared link shows the image itself, not a card';
export const NO_CARD_TITLE_UNSERVABLE =
  'The stored title cannot be sent as it is: re-enter it (one line, up to 120 characters)';
export const NO_CARD_DESCRIPTION_UNSERVABLE =
  'The stored description cannot be sent as it is: re-enter it (up to 240 characters)';
export const NO_CARD_IMAGE_UNSERVABLE =
  'The image cannot be used for a card: choose a bucket with a custom domain and a valid key, or remove the image';
export const NO_CARD_VIDEO_UNSERVABLE =
  'The stored video size cannot be sent as it is: re-enter both the width and height, or clear them';

/**
 * The size given to an image the save will measure. The save reads the real
 * size from the file and refuses the save when it cannot, so a saved image
 * always has a size in range; the card built from it claims none.
 */
const MEASURED_ON_SAVE = 1;

/** The stored preview fields an edit dialog opened on (absent for a create). */
export type StoredPreviewFields = Partial<RoutePreviewFields>;

/** A typed video size as a save sends it: null for none. */
const typedDimension = (text: string): number | null =>
  text.trim() === '' ? null : parsePreviewDimension(text);

/**
 * The preview fields a save of `current` would leave stored, for a dialog
 * that opened as `opened` on `stored` (undefined for a create). A save sends
 * only the fields that changed, and the Worker sanitises what it receives, so
 * each field is either the stored value as it is (unchanged) or the
 * sanitised new one: a blank title clears every field; blank text drops the
 * field; a changed image is the new bucket and key, measured on save, and an
 * empty one removes it; an unchanged image keeps its stored size; a size with
 * no image beside it is dropped, as every write does.
 */
export function previewRecordIfSaved(
  opened: RouteFormValues,
  current: RouteFormValues,
  stored: StoredPreviewFields | undefined,
): { record: Record<string, unknown>; imageMeasuredOnSave: boolean } {
  const record: Record<string, unknown> = {};
  const changed = (field: keyof RouteFormValues) => opened[field] !== current[field];
  const keep = (...fields: (keyof RoutePreviewFields)[]) => {
    for (const field of fields) {
      if (stored?.[field] !== undefined) record[field] = stored[field];
    }
  };

  if (changed('previewTitle')) {
    const title = sanitizePreviewTitle(current.previewTitle);
    // Clearing the title clears every preview field
    if (title === null) return { record: {}, imageMeasuredOnSave: false };
    record['previewTitle'] = title;
  } else keep('previewTitle');

  if (changed('previewDescription')) {
    const description = sanitizePreviewDescription(current.previewDescription);
    if (description !== null) record['previewDescription'] = description;
  } else keep('previewDescription');

  const imageTouched = changed('previewImageBucket') || changed('previewImageKey');
  let imageMeasuredOnSave = false;
  if (!imageTouched) {
    keep('previewImageBucket', 'previewImageKey', 'previewImageWidth', 'previewImageHeight');
  } else if (current.previewImageBucket !== '' && current.previewImageKey !== '') {
    record['previewImageBucket'] = current.previewImageBucket;
    record['previewImageKey'] = current.previewImageKey;
    record['previewImageWidth'] = MEASURED_ON_SAVE;
    record['previewImageHeight'] = MEASURED_ON_SAVE;
    imageMeasuredOnSave = true;
  }

  for (const field of ['previewVideoWidth', 'previewVideoHeight'] as const) {
    if (!changed(field)) {
      keep(field);
      continue;
    }
    const size = typedDimension(current[field]);
    if (size !== null) record[field] = size;
  }
  dropOrphanPreviewImageSize(record);
  return { record, imageMeasuredOnSave };
}

/**
 * Which part of `record` `servablePreview` refuses, found by asking it again
 * on the record cut down part by part (title; with the description; with the
 * image), so no rule is restated here. `record` has a title.
 */
function unservableReason(record: Record<string, unknown>): string {
  const parts = [
    [['previewTitle'], NO_CARD_TITLE_UNSERVABLE],
    [['previewDescription'], NO_CARD_DESCRIPTION_UNSERVABLE],
    [
      ['previewImageBucket', 'previewImageKey', 'previewImageWidth', 'previewImageHeight'],
      NO_CARD_IMAGE_UNSERVABLE,
    ],
  ] as const;
  const kept: Record<string, unknown> = {};
  for (const [fields, reason] of parts) {
    for (const field of fields) {
      if (record[field] !== undefined) kept[field] = record[field];
    }
    if (!servablePreview(kept, isServableR2Key)) return reason;
  }
  // Everything but the video size passes, so the video size is refused
  return NO_CARD_VIDEO_UNSERVABLE;
}

/** Why a route the shared predicate refuses can have no card. */
function ineligibleReason(current: { type: string; path: string }): string {
  if (current.type !== 'r2') return NO_CARD_NOT_FILE;
  if (isWildcardRoutePath(current.path)) return NO_CARD_WILDCARD;
  return NO_CARD_IMAGE_FILE;
}

/**
 * The live card of the route form for the dialog's `opened` and `current`
 * state (with the route's `path`), the `stored` route an edit opened on
 * (undefined for a create), the route's domain `host`, the file's stored
 * content type and `fileStatus` from the dashboard's read of it. `defaults`
 * is the shipped default-image map; a test may pass its own.
 */
export function livePreviewCard({
  opened,
  current,
  path,
  stored,
  host,
  storedContentType,
  fileStatus,
  defaults = PREVIEW_DEFAULT_IMAGES,
}: {
  opened: RouteFormValues;
  current: RouteFormValues;
  path: string;
  stored: StoredPreviewFields | undefined;
  host: string;
  storedContentType: string | undefined;
  fileStatus: PreviewFileStatus;
  defaults?: PreviewDefaultImages;
}): LivePreviewCard {
  if (!current.enabled) return { send: false, reason: NO_CARD_DISABLED };
  const route = { type: current.type, path };
  const contentType = previewFileContentType(current.target, storedContentType);
  if (!isCardEligibleFile(route, contentType)) {
    return { send: false, reason: ineligibleReason(route) };
  }
  if (fileStatus === 'missing') return { send: false, reason: NO_CARD_FILE_MISSING };

  const errors = previewFormErrors(opened, current, true);
  const fieldError = errors.title ?? errors.image ?? errors.videoWidth ?? errors.videoHeight;
  if (fieldError) return { send: false, reason: fieldError };

  const { record, imageMeasuredOnSave } = previewRecordIfSaved(opened, current, stored);
  const servable = servablePreview(record, isServableR2Key);
  if (!servable) {
    const title = record['previewTitle'];
    const titled = typeof title === 'string' && sanitizePreviewTitle(title) !== null;
    return { send: false, reason: titled ? unservableReason(record) : PREVIEW_TITLE_NEEDED };
  }
  // An image the save will measure has no size yet: the card claims none
  const input =
    imageMeasuredOnSave && servable.image
      ? { ...servable, image: { bucket: servable.image.bucket, key: servable.image.key } }
      : servable;
  const card = previewCard(input, host, defaults);
  return {
    send: true,
    card,
    imageCheckedOnSave: imageMeasuredOnSave && card.imageSource === 'route',
    provisional: fileStatus !== 'found',
  };
}

/** Whether the form's file is an image, for the section's note (re-exported for the page). */
export { previewFileIsImage };
