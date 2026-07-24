/**
 * Pure QR form-state helpers (extracted from qr-codes.tsx in v1.58.0 so the
 * payload/design derivation is unit-testable — the review round's MAJOR was a
 * silent stale-credential path in exactly this logic).
 *
 * SECURITY INVARIANT (v1.58.0 review MAJOR): switching auth/EAP method hides
 * form fields but does NOT clear their state — derivation here must therefore
 * EXCLUDE inapplicable fields so hidden stale values can never reach the
 * record. Specifically: TLS (certificate-based) must never submit a password
 * typed under a previous method, and phase-2 applies only to the tunneled
 * methods (PEAP/TTLS).
 */

import { normalizeQrId, WifiAuthSchema } from '@bifrost/shared';
import type { QRCode, QRType } from '@bifrost/shared';

/**
 * Derived from the canonical schema rather than hand-duplicated (v1.58.3):
 * a schema-side addition now widens this union automatically, so
 * `Record<WifiAuthOption, …>` maps below fail to COMPILE until updated,
 * instead of relying on a test to notice.
 */
export type WifiAuthOption = (typeof WifiAuthSchema.options)[number];

/** Brand-design selector value: resolve-by-domain, a preset id, or free-form. */
export type BrandSelection = 'auto' | 'custom' | (string & {});

/** EAP methods that tunnel a phase-2 inner auth (PH2 applies to these only). */
export const TUNNELED_EAP_METHODS = ['PEAP', 'TTLS'] as const;

/**
 * Short labels for the Wi-Fi security SELECT TRIGGER (v1.58.3).
 *
 * The dropdown keeps the long protocol-bearing labels — teaching that one
 * "Password-protected" entry covers WPA/WPA2/WPA3 is the whole point of the
 * v1.58.0 category picker. But the trigger sits in a half-width grid column,
 * where "Password-protected (WPA / WPA2 / WPA3)" overflowed its border and
 * ran under the chevron. Short trigger + full menu keeps both.
 */
export const WIFI_AUTH_TRIGGER_LABELS: Record<WifiAuthOption, string> = {
  WPA: 'Password-protected',
  'WPA2-EAP': 'Enterprise (802.1X)',
  nopass: 'Open (no password)',
  WEP: 'WEP (legacy)',
};

export interface QrFormState {
  type: QRType;
  id: string;
  /**
   * True once the user edits the Reference by hand — prefill stops there and
   * never overwrites a deliberate choice. Always true in edit mode, where the
   * id is the immutable KV key.
   */
  idTouched: boolean;
  description: string;
  tags: string;
  url: string;
  text: string;
  ssid: string;
  auth: WifiAuthOption;
  password: string;
  hidden: boolean;
  eapMethod: string;
  phase2: string;
  identity: string;
  anonymousIdentity: string;
  name: string;
  phone: string;
  email: string;
  org: string;
  title: string;
  vurl: string;
  brandSel: BrandSelection;
  fg: string;
  bg: string;
  size: number;
  margin: number;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  logoDataUri: string;
  /** Client-computed intrinsic w/h of the embedded logo (wide-logo mode). */
  logoAspectRatio: number | null;
}

export function stateFromQr(qr?: QRCode): QrFormState {
  const p = (qr?.payload ?? {}) as Record<string, unknown>;
  return {
    type: qr?.type ?? 'url',
    id: qr?.id ?? '',
    idTouched: Boolean(qr),
    description: qr?.description ?? '',
    tags: (qr?.tags ?? []).join(', '),
    url: typeof p.url === 'string' ? p.url : '',
    text: typeof p.text === 'string' ? p.text : '',
    ssid: typeof p.ssid === 'string' ? p.ssid : '',
    // Validated, not cast (v1.58.3): every sibling field type-guards, and an
    // out-of-enum stored value would now render a BLANK security trigger
    // (SelectValue takes explicit children) plus an unexplainable 400 on save.
    auth: WifiAuthSchema.catch('WPA').parse(p.auth),
    password: typeof p.password === 'string' ? p.password : '',
    hidden: p.hidden === true,
    eapMethod: typeof p.eapMethod === 'string' ? p.eapMethod : 'PEAP',
    phase2: typeof p.phase2 === 'string' ? p.phase2 : 'MSCHAPV2',
    identity: typeof p.identity === 'string' ? p.identity : '',
    anonymousIdentity: typeof p.anonymousIdentity === 'string' ? p.anonymousIdentity : '',
    name: typeof p.name === 'string' ? p.name : '',
    phone: typeof p.phone === 'string' ? p.phone : '',
    email: typeof p.email === 'string' ? p.email : '',
    org: typeof p.org === 'string' ? p.org : '',
    title: typeof p.title === 'string' ? p.title : '',
    vurl: qr?.type === 'vcard' && typeof p.url === 'string' ? p.url : '',
    // Edit shows the stored design as-is (Custom); create resolves the brand
    // preset from the selected domain until the user says otherwise.
    brandSel: qr ? 'custom' : 'auto',
    fg: qr?.design.fg ?? '#000000',
    bg: qr?.design.bg ?? '#ffffff',
    size: qr?.design.size ?? 512,
    margin: qr?.design.margin ?? 4,
    errorCorrection: qr?.design.errorCorrection ?? 'M',
    logoDataUri: qr?.design.logoDataUri ?? '',
    logoAspectRatio: qr?.design.logoAspectRatio ?? null,
  };
}

/** Hostname of a URL, `www.` stripped — '' when unparseable (mid-typing). */
function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Suggested Reference for a not-yet-named QR (v1.58.5; description decoupled
 * v1.58.7). Sourced from the type's most identifying payload field only.
 * Returns '' when there is nothing to go on yet, so the caller leaves the
 * field alone rather than writing a placeholder.
 */
export function suggestQrId(s: QrFormState): string {
  // Deliberately NOT sourced from the description (v1.58.7): the Reference is
  // the code's stable address and the description is free-form prose — linking
  // the two made editing one silently rewrite the other. Only the type's most
  // identifying payload field seeds the suggestion.
  const source =
    (s.type === 'wifi' ? s.ssid : '') ||
    (s.type === 'url' ? hostFromUrl(s.url) : '') ||
    (s.type === 'vcard' ? s.name : '') ||
    (s.type === 'text' ? s.text : '');
  return normalizeQrId(source);
}

export function payloadFromState(s: QrFormState): Record<string, unknown> {
  switch (s.type) {
    case 'url':
      return { url: s.url };
    case 'text':
      return { text: s.text };
    case 'wifi':
      if (s.auth === 'WPA2-EAP') {
        const tunneled = (TUNNELED_EAP_METHODS as readonly string[]).includes(s.eapMethod);
        return {
          ssid: s.ssid,
          auth: s.auth,
          eapMethod: s.eapMethod,
          // PH2 only for tunneled methods — TLS/PWD have no inner auth.
          ...(tunneled ? { phase2: s.phase2 } : {}),
          identity: s.identity,
          ...(s.anonymousIdentity ? { anonymousIdentity: s.anonymousIdentity } : {}),
          // TLS is certificate-based: NEVER submit a password (the field is
          // hidden in the UI, so any value here is stale state from a prior
          // method — silently encoding it would leak a credential).
          ...(s.eapMethod !== 'TLS' && s.password ? { password: s.password } : {}),
          hidden: s.hidden,
        };
      }
      return {
        ssid: s.ssid,
        auth: s.auth,
        ...(s.auth !== 'nopass' && s.password ? { password: s.password } : {}),
        hidden: s.hidden,
      };
    case 'vcard':
      return {
        name: s.name,
        ...(s.phone ? { phone: s.phone } : {}),
        ...(s.email ? { email: s.email } : {}),
        ...(s.org ? { org: s.org } : {}),
        ...(s.title ? { title: s.title } : {}),
        ...(s.vurl ? { url: s.vurl } : {}),
      };
  }
}

export function designFromState(s: QrFormState): Record<string, unknown> {
  return {
    fg: s.fg,
    bg: s.bg,
    size: s.size,
    margin: s.margin,
    errorCorrection: s.errorCorrection,
    ...(s.logoDataUri ? { logoDataUri: s.logoDataUri } : {}),
    ...(s.logoDataUri && s.logoAspectRatio ? { logoAspectRatio: s.logoAspectRatio } : {}),
  };
}
