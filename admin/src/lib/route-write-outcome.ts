import { isUncertainAnswer } from './api-error';

/**
 * The toast for a failed route write on the Routes page (v1.41.2): a write
 * that may have landed (`isUncertainAnswer`: no answer, a 5xx, an unreadable
 * body, a 2xx that confirmed nothing) says it could not be confirmed (the
 * route hooks have dropped what they knew and refetch the listings); a
 * definite refusal (a 4xx answer, or a `RouteWriteRefusedError`, refused
 * before any request) keeps `failed` and the reason. `action` names the
 * write as a noun ("migration"), `failed` is the page's definite text
 * ("Failed to migrate route").
 */
export function routeWriteFailureText(error: unknown, action: string, failed: string): string {
  if (isUncertainAnswer(error)) {
    return `Could not confirm the ${action}: it may have gone through. The list is reloading.`;
  }
  return `${failed}: ${error instanceof Error ? error.message : 'Unknown error'}`;
}
