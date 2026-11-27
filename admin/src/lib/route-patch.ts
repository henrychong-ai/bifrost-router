import {
  getContentTypeFromKey,
  isCardEligibleFile,
  isServableR2Key,
  isWildcardRoutePath,
  PREVIEW_VIDEO_DIMENSION_MAX,
  sanitizePreviewDescription,
  sanitizePreviewTitle,
} from '@bifrost/shared';
import type { Route, UpdateRouteInput } from './schemas';
import { isR2BucketName, isRedirectStatusCode } from './schemas';

/**
 * The route edit form's values as it displays them (v1.38.0): an unset Force
 * Download shows as off, an unset bucket as `files`, an unset status code as
 * 302, cleared text fields as `''`. A stored status code or bucket no write
 * accepts today is shown as WHAT IT IS, marked not supported, so choosing a
 * supported value (the default included) is a change and is sent.
 */
export interface RouteFormValues {
  type: Route['type'];
  target: string;
  /** A redirect status code, or a stored one no write accepts. */
  statusCode: number;
  preserveQuery: boolean;
  preservePath: boolean;
  cacheControl: string;
  hostHeader: string;
  forceDownload: boolean;
  /** An R2 bucket, or a stored one no write accepts. */
  bucket: string;
  enabled: boolean;
  /** Link preview (v1.48.0, r2 routes): '' means none; the video size as typed */
  previewTitle: string;
  previewDescription: string;
  previewImageBucket: string;
  previewImageKey: string;
  previewVideoWidth: string;
  previewVideoHeight: string;
}

/** The six link-preview fields of the form (v1.48.0). */
export const PREVIEW_FORM_FIELDS = [
  'previewTitle',
  'previewDescription',
  'previewImageBucket',
  'previewImageKey',
  'previewVideoWidth',
  'previewVideoHeight',
] as const satisfies ReadonlyArray<keyof RouteFormValues>;

/** The form values a new route opens with. */
export const NEW_ROUTE_FORM_VALUES: RouteFormValues = {
  type: 'redirect',
  target: '',
  statusCode: 302,
  preserveQuery: true,
  preservePath: false,
  cacheControl: '',
  hostHeader: '',
  forceDownload: false,
  bucket: 'files',
  enabled: true,
  previewTitle: '',
  previewDescription: '',
  previewImageBucket: '',
  previewImageKey: '',
  previewVideoWidth: '',
  previewVideoHeight: '',
};

/** The edit dialog's dirty fields, before the unsupported-value check. */
export type RouteEditPatch = Partial<RouteFormValues>;

/** The form's values for a stored route, as the edit dialog shows them when it opens. */
export function routeFormValues(route: Route): RouteFormValues {
  return {
    type: route.type,
    target: route.target,
    statusCode: route.statusCode ?? 302,
    preserveQuery: route.preserveQuery ?? true,
    preservePath: route.preservePath ?? false,
    cacheControl: route.cacheControl ?? '',
    hostHeader: route.hostHeader ?? '',
    forceDownload: route.forceDownload ?? false,
    bucket: route.bucket ?? 'files',
    enabled: route.enabled ?? true,
    previewTitle: route.previewTitle ?? '',
    previewDescription: route.previewDescription ?? '',
    previewImageBucket: route.previewImageBucket ?? '',
    previewImageKey: route.previewImageKey ?? '',
    previewVideoWidth: route.previewVideoWidth ? String(route.previewVideoWidth) : '',
    previewVideoHeight: route.previewVideoHeight ? String(route.previewVideoHeight) : '',
  };
}

/**
 * Whether the form's route can carry a link preview (v1.48.0): an r2 route
 * that serves one file, never a wildcard route (the Worker's
 * `previewRuleError`).
 */
export function formAllowsPreview(form: { type: string; path: string }): boolean {
  return form.type === 'r2' && !isWildcardRoutePath(form.path);
}

/**
 * The content type the serving handler judges the form's file by: its stored
 * content type when the dashboard has read it, else its key's extension, else
 * a generic binary.
 */
export function previewFileContentType(target: string, storedContentType: unknown): string {
  return (
    storedContentTypeOf(storedContentType) ||
    getContentTypeFromKey(target) ||
    'application/octet-stream'
  );
}

/**
 * A stored content type as read from the network: only a non-empty string
 * counts; anything else is no stored type, so the file name decides.
 */
export function storedContentTypeOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Whether the form's file previews as itself rather than as a card: judged
 * as the serving handler judges it, by its stored content type when read,
 * else by its key's extension, through the shared `isCardEligibleFile`.
 */
export function previewFileIsImage(
  form: { type: string; path: string; target: string },
  storedContentType: unknown,
): boolean {
  if (!form.target) return false;
  const route = { type: form.type, path: form.path };
  return (
    isCardEligibleFile(route, 'application/octet-stream') &&
    !isCardEligibleFile(route, previewFileContentType(form.target, storedContentType))
  );
}

/** A typed video size: a whole number from 1 to the limit, or null when it is empty or not one. */
export function parsePreviewDimension(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= PREVIEW_VIDEO_DIMENSION_MAX
    ? value
    : null;
}

/** Whether typed text is empty or whitespace only. */
const blank = (value: string) => value.trim() === '';

/** Typed text, or undefined when it is blank. */
const filledText = (value: string) => (blank(value) ? undefined : value);

/**
 * A typed video size as the API takes it: blank clears it (null); an
 * invalid one is never sent (the form's errors hold the save).
 */
const sentDimension = (typed: string | undefined) =>
  typed === undefined ? undefined : blank(typed) ? null : parsePreviewDimension(typed);

export const PREVIEW_TITLE_NEEDED = 'Add a title';
export const PREVIEW_IMAGE_INCOMPLETE = 'Choose a bucket and enter a key';
export const PREVIEW_VIDEO_PAIR_NEEDED =
  'Enter both the video width and height, or leave both empty.';
export const PREVIEW_DIMENSION_INVALID = `Enter a whole number from 1 to ${PREVIEW_VIDEO_DIMENSION_MAX}, or leave it empty.`;

/** The link-preview field errors: null where a field has none. */
export interface PreviewFieldErrors {
  title: string | null;
  image: string | null;
  videoWidth: string | null;
  videoHeight: string | null;
}

const NO_PREVIEW_ERRORS: PreviewFieldErrors = {
  title: null,
  image: null,
  videoWidth: null,
  videoHeight: null,
};

/**
 * The link-preview field errors of `current`, judged against the state the
 * form `opened` with (v1.48.0); a create opens with every field blank. The
 * fields are judged only once one of them changed: stored values left as
 * they were, even off-shape ones, never produce an error and are not sent.
 * Blanking a stored title clears the whole preview and is always allowed.
 * Otherwise a blank title with any other field set needs a title; the image
 * needs its bucket and its key, or neither; the video size its width and
 * height, or neither, each a whole number from 1 to the limit. `allowed` is
 * {@link formAllowsPreview} of the form: where no preview may be, none is
 * judged (and an edit clears a stored one).
 */
export function previewFormErrors(
  opened: RouteFormValues,
  current: RouteFormValues,
  allowed: boolean,
): PreviewFieldErrors {
  if (!allowed) return NO_PREVIEW_ERRORS;
  if (PREVIEW_FORM_FIELDS.every(field => opened[field] === current[field])) {
    return NO_PREVIEW_ERRORS;
  }
  const titleBlank = blank(current.previewTitle);
  if (titleBlank && !blank(opened.previewTitle)) return NO_PREVIEW_ERRORS;
  const pairBroken = blank(current.previewVideoWidth) !== blank(current.previewVideoHeight);
  const videoError = (own: string) =>
    !blank(own) && parsePreviewDimension(own) === null
      ? PREVIEW_DIMENSION_INVALID
      : pairBroken && blank(own)
        ? PREVIEW_VIDEO_PAIR_NEEDED
        : null;
  return {
    title:
      titleBlank &&
      PREVIEW_FORM_FIELDS.some(field => field !== 'previewTitle' && !blank(current[field]))
        ? PREVIEW_TITLE_NEEDED
        : null,
    image:
      blank(current.previewImageBucket) === blank(current.previewImageKey)
        ? null
        : PREVIEW_IMAGE_INCOMPLETE,
    videoWidth: videoError(current.previewVideoWidth),
    videoHeight: videoError(current.previewVideoHeight),
  };
}

/** Whether the link-preview section blocks saving: one of its fields has an error. */
export function previewFormBlocked(
  opened: RouteFormValues,
  current: RouteFormValues,
  allowed: boolean,
): boolean {
  const errors = previewFormErrors(opened, current, allowed);
  return [errors.title, errors.image, errors.videoWidth, errors.videoHeight].some(
    error => error !== null,
  );
}

/**
 * The link-preview fields of a new route (v1.48.0): those that hold a value,
 * only where a preview may be and with a title (a blank title means no
 * preview, whatever else was typed).
 */
export function previewCreateFields(
  form: RouteFormValues,
  allowed: boolean,
): {
  previewTitle?: string;
  previewDescription?: string;
  previewImageBucket?: string;
  previewImageKey?: string;
  previewVideoWidth?: number;
  previewVideoHeight?: number;
} {
  if (!allowed || blank(form.previewTitle)) return {};
  const fields = {
    previewTitle: filledText(form.previewTitle),
    previewDescription: filledText(form.previewDescription),
    previewImageBucket: filledText(form.previewImageBucket),
    previewImageKey: filledText(form.previewImageKey),
    previewVideoWidth: parsePreviewDimension(form.previewVideoWidth) ?? undefined,
    previewVideoHeight: parsePreviewDimension(form.previewVideoHeight) ?? undefined,
  };
  // Only the fields that hold a value
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Fields every route uses. */
const COMMON_FIELDS = ['type', 'enabled', 'cacheControl'] as const;

/** Fields each route type uses, all sent when the type changes. */
const TYPE_FIELDS = {
  redirect: ['target', 'statusCode', 'preserveQuery', 'preservePath'],
  proxy: ['target', 'preserveQuery', 'hostHeader'],
  r2: ['target', 'bucket', 'forceDownload'],
} as const satisfies Record<Route['type'], ReadonlyArray<keyof RouteFormValues>>;

/**
 * The link-preview part of an edit (v1.48.0): the preview fields that
 * changed, where a preview may be. A blank title clears every preview field
 * (only `previewTitle: ''` is sent: the Worker clears the rest). Where no
 * preview may be (another type, a wildcard path), a route that had one sends
 * `previewTitle: ''`, so the save is not refused for it.
 */
function previewEditPatch(
  opened: RouteFormValues,
  final: RouteFormValues,
  allowed: boolean,
): RouteEditPatch {
  const hadTitle = opened.previewTitle.trim() !== '';
  if (!allowed) return hadTitle ? { previewTitle: '' } : {};
  if (final.previewTitle.trim() === '') {
    return hadTitle ? { previewTitle: '' } : {};
  }
  const patch: RouteEditPatch = {};
  for (const field of PREVIEW_FORM_FIELDS) {
    if (final[field] !== opened[field]) Object.assign(patch, { [field]: final[field] });
  }
  return patch;
}

/**
 * The update the route edit dialog sends (v1.38.0): only DIRTY fields, each
 * final form value compared with the value the form showed when the dialog
 * opened, never with the stored record and copied server defaults. So an
 * untouched field (a target written under older limits, an unset Force
 * Download, a missing bucket) is never sent; a switch toggled on and off
 * again is not dirty; a cleared text field that showed a value sends `''`,
 * which clears it. When the type changes, every field the new type uses is
 * sent as the form has it, the bucket explicitly. Fields the final type does
 * not use are never sent. `{}` means nothing changed (no request).
 */
export function routeEditPatch(
  opened: RouteFormValues,
  final: RouteFormValues,
  /** {@link formAllowsPreview} of the final form (v1.48.0); by default, an r2 type */
  previewAllowed: boolean = final.type === 'r2',
): RouteEditPatch {
  const typeChanged = final.type !== opened.type;
  const uses: ReadonlyArray<keyof RouteFormValues> = TYPE_FIELDS[final.type];
  const patch: RouteEditPatch = {};
  for (const field of [...COMMON_FIELDS, ...uses]) {
    if ((typeChanged && uses.includes(field)) || final[field] !== opened[field]) {
      Object.assign(patch, { [field]: final[field] });
    }
  }
  return { ...patch, ...previewEditPatch(opened, final, previewAllowed) };
}

/**
 * The fields of a patch that would send a value no write accepts (v1.38.0):
 * a stored status code or bucket shown as it is and sent unchanged because the
 * type changed. The dialog says so and saves nothing until another is chosen.
 */
export function unsupportedPatchFields(patch: RouteEditPatch): Array<'statusCode' | 'bucket'> {
  const fields: Array<'statusCode' | 'bucket'> = [];
  if (patch.statusCode !== undefined && !isRedirectStatusCode(patch.statusCode)) {
    fields.push('statusCode');
  }
  if (patch.bucket !== undefined && !isR2BucketName(patch.bucket)) fields.push('bucket');
  return fields;
}

/** The patch as the update the API takes; null when it holds an unsupported value. */
export function toUpdateRouteInput(patch: RouteEditPatch): UpdateRouteInput | null {
  const { statusCode, bucket, previewVideoWidth, previewVideoHeight, ...rest } = patch;
  if (statusCode !== undefined && !isRedirectStatusCode(statusCode)) return null;
  if (bucket !== undefined && !isR2BucketName(bucket)) return null;
  const width = sentDimension(previewVideoWidth);
  const height = sentDimension(previewVideoHeight);
  return {
    ...rest,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(bucket === undefined ? {} : { bucket }),
    ...(width === undefined ? {} : { previewVideoWidth: width }),
    ...(height === undefined ? {} : { previewVideoHeight: height }),
  };
}

/**
 * What is wrong with a route target for its type, or null (v1.38.0). Checked
 * whenever the target is new to the route: typed, or kept through a TYPE
 * change, so an r2 object key never becomes a redirect's target and a URL
 * never becomes an r2 key unchecked. A redirect needs an absolute URL (a
 * `mailto:` or `tel:` link included, as the router serves them), a proxy an
 * absolute http(s) URL, an r2 route an object key the Worker would serve as
 * it is.
 */
export function routeTargetProblem(type: Route['type'], target: string): string | null {
  if (type === 'r2') {
    return isServableR2Key(target)
      ? null
      : 'Enter an R2 object key (such as docs/report.pdf), not a URL, before saving.';
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'Enter a valid absolute target URL before saving.';
  }
  if (type === 'proxy' && url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'A proxy target must be an http or https URL.';
  }
  return null;
}

/**
 * The fields of a migrate-with-patch that the moved route does not show
 * (v1.38.0): an older Worker moves the record and ignores the patch, so its
 * answer is checked. A cleared text field (`''`) counts as applied when the
 * route holds none.
 */
export function unappliedPatchFields(patch: UpdateRouteInput, route: Route): string[] {
  const routeFields = new Map<string, unknown>(Object.entries(route));
  // A cleared title clears every preview field (v1.48.0)
  const previewCleared = patch.previewTitle === '';
  return Object.entries(patch)
    .filter(([field, value]) => {
      const stored = routeFields.get(field);
      if (previewCleared && field.startsWith('preview')) return stored !== undefined;
      // The Worker sanitises preview text and stores a cleared size as none
      const sent =
        field === 'previewTitle' && typeof value === 'string'
          ? (sanitizePreviewTitle(value) ?? '')
          : field === 'previewDescription' && typeof value === 'string'
            ? (sanitizePreviewDescription(value) ?? '')
            : value === null
              ? ''
              : value;
      if (sent === '' && (stored === undefined || stored === '')) return false;
      return stored !== sent;
    })
    .map(([field]) => field);
}
