import { isRecord } from '@bifrost/shared';

/** Navigation state the QR page accepts: open on this domain. */
export interface QrPageNavState {
  domain?: string;
}

/** The domain navigation state names, if it names one at all. */
export function qrPageNavDomain(state: unknown): string | undefined {
  const requested = isRecord(state) ? state['domain'] : undefined;
  return typeof requested === 'string' ? requested : undefined;
}

/**
 * The domain the QR page opens on: the one navigation state names, when it is
 * a domain the page offers ("Save as QR Code" on the Routes page sends the new
 * code's domain), else the first offered domain.
 */
export function initialQrPageDomain(state: unknown, allowed: readonly string[]): string {
  const requested = qrPageNavDomain(state);
  if (requested !== undefined && allowed.includes(requested)) return requested;
  return allowed[0] ?? 'example.com';
}
