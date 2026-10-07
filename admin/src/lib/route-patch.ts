import type { R2BucketName, RedirectStatusCode, Route, UpdateRouteInput } from './schemas';
import { isR2BucketName, isRedirectStatusCode } from './schemas';

/**
 * The route edit form's values as it displays them (v1.38.0): an unset Force
 * Download shows as off, an unset or unknown bucket as `files`, an unset or
 * unknown status code as 302, cleared text fields as `''`.
 */
export interface RouteFormValues {
  type: Route['type'];
  target: string;
  statusCode: RedirectStatusCode;
  preserveQuery: boolean;
  preservePath: boolean;
  cacheControl: string;
  hostHeader: string;
  forceDownload: boolean;
  bucket: R2BucketName;
  enabled: boolean;
}

/** The form's values for a stored route, as the edit dialog shows them when it opens. */
export function routeFormValues(route: Route): RouteFormValues {
  return {
    type: route.type,
    target: route.target,
    statusCode: isRedirectStatusCode(route.statusCode) ? route.statusCode : 302,
    preserveQuery: route.preserveQuery ?? true,
    preservePath: route.preservePath ?? false,
    cacheControl: route.cacheControl ?? '',
    hostHeader: route.hostHeader ?? '',
    forceDownload: route.forceDownload ?? false,
    bucket: isR2BucketName(route.bucket) ? route.bucket : 'files',
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
export function routeEditPatch(opened: RouteFormValues, final: RouteFormValues): UpdateRouteInput {
  const typeChanged = final.type !== opened.type;
  const uses: ReadonlyArray<keyof RouteFormValues> = TYPE_FIELDS[final.type];
  const patch: Partial<RouteFormValues> = {};
  for (const field of [...COMMON_FIELDS, ...uses]) {
    if ((typeChanged && uses.includes(field)) || final[field] !== opened[field]) {
      Object.assign(patch, { [field]: final[field] });
    }
  }
  return patch;
}
