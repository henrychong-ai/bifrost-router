import { isServableR2Key } from '@bifrost/shared';
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
}

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
  };
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
export function routeEditPatch(opened: RouteFormValues, final: RouteFormValues): RouteEditPatch {
  const typeChanged = final.type !== opened.type;
  const uses: ReadonlyArray<keyof RouteFormValues> = TYPE_FIELDS[final.type];
  const patch: RouteEditPatch = {};
  for (const field of [...COMMON_FIELDS, ...uses]) {
    if ((typeChanged && uses.includes(field)) || final[field] !== opened[field]) {
      Object.assign(patch, { [field]: final[field] });
    }
  }
  return patch;
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
  const { statusCode, bucket, ...rest } = patch;
  if (statusCode !== undefined && !isRedirectStatusCode(statusCode)) return null;
  if (bucket !== undefined && !isR2BucketName(bucket)) return null;
  return {
    ...rest,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(bucket === undefined ? {} : { bucket }),
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
  return Object.entries(patch)
    .filter(([field, value]) => {
      const stored = routeFields.get(field);
      if (value === '' && (stored === undefined || stored === '')) return false;
      return stored !== value;
    })
    .map(([field]) => field);
}
