import { HTTPException } from 'hono/http-exception';

/**
 * A refusal with a machine code (v1.38.0): the one shape for every coded
 * answer, `{ success: false, error: <code>, message }`, so clients can tell
 * the code from the sentence (`ROUTE_RECORD_INVALID`, `QR_NOT_FOUND`,
 * `QR_RECORD_INVALID`). The JSON response is built here, so the answer is the
 * same wherever it is thrown: the app's `onError` returns an HTTPException's
 * own response, as Hono's default handler does for a sub-app on its own.
 */
export class CodedHTTPException extends HTTPException {
  constructor(
    status: 400 | 404 | 409 | 415,
    readonly code: string,
    message: string,
  ) {
    super(status, {
      message,
      res: Response.json({ success: false, error: code, message }, { status }),
    });
    this.name = 'CodedHTTPException';
  }
}
