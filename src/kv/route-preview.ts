/**
 * How the link-preview fields (v1.48.0) are written: created, patched and
 * cleared. One definition for create (`normalizeNewPreview`) and one for an
 * update or a move with changes (`applyPreviewPatch`), so the record the
 * rules check is the record written.
 *
 * - Text is sanitised like a comment (`sanitizePreviewTitle`,
 *   `sanitizePreviewDescription`); empty or whitespace-only text drops the
 *   field, and an empty image bucket or key drops the whole image (both
 *   fields and the measured size).
 * - Clearing the title clears EVERY preview field.
 * - The image's pixel size is server-derived: the handler reads it from the
 *   image (`src/routes/route-preview-image.ts`) and passes it here; it is
 *   dropped whenever the record names no image.
 * - An update clears a video size with `null`.
 */

import {
  dropOrphanPreviewImageSize,
  PREVIEW_FIELDS,
  sanitizePreviewDescription,
  sanitizePreviewTitle,
} from '@bifrost/shared';
import type { KVRouteConfig } from '../types';

/** The image size read from the image itself (never from the client). */
export interface PreviewImageSize {
  previewImageWidth: number;
  previewImageHeight: number;
}

/** The preview fields a write may carry, as parsed, plus the derived image size. */
export interface PreviewWriteFields {
  previewTitle?: string | undefined;
  previewDescription?: string | undefined;
  previewImageBucket?: string | undefined;
  previewImageKey?: string | undefined;
  previewImageWidth?: number | undefined;
  previewImageHeight?: number | undefined;
  previewVideoWidth?: number | null | undefined;
  previewVideoHeight?: number | null | undefined;
}

type Mutable = Record<string, unknown>;

/** Remove the image reference and its measured size. */
function clearImage(record: Mutable): void {
  delete record['previewImageBucket'];
  delete record['previewImageKey'];
  delete record['previewImageWidth'];
  delete record['previewImageHeight'];
}

/**
 * The preview fields of a NEW route as they are stored: text sanitised,
 * empty values dropped, a null video size dropped, the image size kept only
 * beside an image. Returns a copy; idempotent, so the handler may apply it
 * before the rules and the write applies it again.
 */
export function normalizeNewPreview<T extends object>(input: T): T {
  const record = { ...input } as Mutable;
  const title = sanitizePreviewTitle(record['previewTitle'] as string | undefined);
  if (title === null) delete record['previewTitle'];
  else record['previewTitle'] = title;
  const description = sanitizePreviewDescription(
    record['previewDescription'] as string | undefined,
  );
  if (description === null) delete record['previewDescription'];
  else record['previewDescription'] = description;
  // An empty image bucket OR key means "no image": both go, with the size
  if (record['previewImageBucket'] === '' || record['previewImageKey'] === '') clearImage(record);
  for (const field of ['previewImageBucket', 'previewImageKey'] as const) {
    if (record[field] == null) delete record[field];
  }
  for (const field of ['previewVideoWidth', 'previewVideoHeight'] as const) {
    if (record[field] == null) delete record[field];
  }
  // The size goes when no complete image is named (shared with the dashboard)
  dropOrphanPreviewImageSize(record);
  return record as T;
}

/**
 * Apply the preview fields of `updates` to `merged` (the stored record with
 * the patch already spread over it), in place. Only a field the patch names
 * is touched; an untouched image keeps its stored size.
 */
export function applyPreviewPatch(merged: KVRouteConfig, updates: PreviewWriteFields): void {
  const record = merged as unknown as Mutable;
  const names = (field: keyof PreviewWriteFields) => updates[field] !== undefined;

  if (names('previewTitle')) {
    const title = sanitizePreviewTitle(updates.previewTitle);
    if (title === null) {
      // Clearing the title clears every preview field
      for (const field of PREVIEW_FIELDS) delete record[field];
      return;
    }
    record['previewTitle'] = title;
  }
  if (names('previewDescription')) {
    const description = sanitizePreviewDescription(updates.previewDescription);
    if (description === null) delete record['previewDescription'];
    else record['previewDescription'] = description;
  }
  const imageTouched = names('previewImageBucket') || names('previewImageKey');
  // An explicitly empty bucket OR key clears the whole image: both reference
  // fields and both measured sizes
  if (updates.previewImageBucket === '' || updates.previewImageKey === '') clearImage(record);
  for (const field of ['previewVideoWidth', 'previewVideoHeight'] as const) {
    if (updates[field] === null) delete record[field];
  }
  if (imageTouched && (updates.previewImageWidth === undefined || !record['previewImageKey'])) {
    // A changed image is measured again by the handler; without a fresh size
    // the stored one would describe the previous image
    delete record['previewImageWidth'];
    delete record['previewImageHeight'];
  }
  // The size goes when no complete image is named (shared with the dashboard)
  dropOrphanPreviewImageSize(record);
}

/**
 * Whether a patch must have the preview rules checked on its result: it
 * names a preview field, or changes a field the rules depend on (the type).
 * A move to a new path checks them too when that path is a wildcard
 * (`isWildcardRoutePath`), which the caller decides. Stored preview data
 * never refuses any other edit.
 */
export function patchAppliesPreviewRules(patch: object): boolean {
  const fields = patch as Record<string, unknown>;
  return [...PREVIEW_FIELDS, 'type'].some(field => fields[field] !== undefined);
}
