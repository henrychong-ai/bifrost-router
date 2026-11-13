import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../types';

/** The machine code of a write whose body is over its ceiling. */
export const PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

/**
 * A per-route request-body ceiling for a JSON write. The route and QR write
 * handlers buffer the whole body with `c.req.json()` before any schema sees
 * it, so the field caps cannot bound what is read; this does. A body over
 * `maxBytes` answers 413 `{ success: false, error: 'PAYLOAD_TOO_LARGE',
 * message }` (the coded-refusal shape) and the handler never runs. With a
 * numeric Content-Length the declared size decides, unread; without one the
 * body is counted while it is read.
 */
export function writeBodyLimit(maxBytes: number, what: string): MiddlewareHandler<AppEnv> {
  const message = `Request body exceeds the ${maxBytes / 1024} KB limit for ${what}`;
  return bodyLimit({
    maxSize: maxBytes,
    onError: c => c.json({ success: false as const, error: PAYLOAD_TOO_LARGE, message }, 413),
  });
}
