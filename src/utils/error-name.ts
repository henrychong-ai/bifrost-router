/**
 * A thrown value as a fixed classification for a log line (v1.39.0): the
 * class name of an Error (`TypeError`, `AbortError`), else its JavaScript
 * type. Never the message or the stack, which can quote a URL, and so a
 * visitor's path or query (a KV or D1 failure names the key it read, a URL
 * parse failure the URL). A name that is not a plain identifier, which only
 * an object that was built to look like an error can carry, is reported as
 * `Error`.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    return /^[A-Za-z_$][\w$]{0,63}$/.test(error.name) ? error.name : 'Error';
  }
  return error === null ? 'null' : typeof error;
}
