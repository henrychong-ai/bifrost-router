/**
 * Dashboard reads of stored and remote JSON (v1.38.0): each value is parsed
 * as unknown and validated with a schema before the UI uses it.
 */
import { type FeedbackCaptureBundle, FeedbackCaptureBundleSchema } from '@bifrost/shared';
import { z } from 'zod';

/**
 * A stored feedback capture attachment, or null when it is not JSON or not a
 * capture bundle (the detail dialog then shows none).
 */
export function parseStoredCapture(text: string): FeedbackCaptureBundle | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = FeedbackCaptureBundleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The identity the container's Tailscale front door reports. */
export const TailscaleIdentitySchema = z.object({
  login: z.string().nullable(),
  name: z.string().nullable(),
  profilePic: z.string().nullable(),
  isAuthenticated: z.boolean(),
});
export type TailscaleIdentity = z.infer<typeof TailscaleIdentitySchema>;

/** The signed-out identity, also used for an answer that is not an identity. */
export const SIGNED_OUT_IDENTITY: TailscaleIdentity = {
  login: null,
  name: null,
  profilePic: null,
  isAuthenticated: false,
};

/** An identity answer read as unknown: the identity, or the signed-out one. */
export function parseTailscaleIdentity(value: unknown): TailscaleIdentity {
  const parsed = TailscaleIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : SIGNED_OUT_IDENTITY;
}
