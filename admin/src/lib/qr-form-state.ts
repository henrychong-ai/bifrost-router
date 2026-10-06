/**
 * Pure QR form-state helpers (extracted from qr-codes.tsx so the
 * payload/design derivation is unit-testable, including the stale-credential
 * invariant below).
 *
 * SECURITY INVARIANT: switching auth/EAP method hides
 * form fields but does NOT clear their state — derivation here must therefore
 * EXCLUDE inapplicable fields so hidden stale values can never reach the
 * record. Specifically: TLS (certificate-based) must never submit a password
 * typed under a previous method, and phase-2 applies only to the tunneled
 * methods (PEAP/TTLS).
 */

import type { QRCode, QRType } from '@bifrost/shared';
import { isSupportedDomain, normalizeQrId, WifiAuthSchema } from '@bifrost/shared';

/**
 * Derived from the canonical schema rather than hand-duplicated:
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
 * Short labels for the Wi-Fi security SELECT TRIGGER.
 *
 * The dropdown keeps the long protocol-bearing labels — teaching that one
 * "Password-protected" entry covers WPA/WPA2/WPA3 is the whole point of the
 * category picker. But the trigger sits in a half-width grid column,
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
  /**
   * Linked route (v1.38.0, url codes only): `static` encodes the URL itself;
   * `existing` links a route picked on the code's domain; `new` creates a
   * 302 redirect at `newRoutePath` to `newRouteTarget` and links it.
   */
  linkMode: 'static' | 'existing' | 'new';
  linkedRoute: QRCode['linkedRoute'] | null;
  newRoutePath: string;
  newRouteTarget: string;
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
    url: typeof p['url'] === 'string' ? p['url'] : '',
    linkMode: qr?.linkedRoute ? 'existing' : 'static',
    linkedRoute: qr?.linkedRoute ?? null,
    newRoutePath: '',
    newRouteTarget: '',
    text: typeof p['text'] === 'string' ? p['text'] : '',
    ssid: typeof p['ssid'] === 'string' ? p['ssid'] : '',
    // Validated, not cast: every sibling field type-guards, and an
    // out-of-enum stored value would now render a BLANK security trigger
    // (SelectValue takes explicit children) plus an unexplainable 400 on save.
    auth: WifiAuthSchema.catch('WPA').parse(p['auth']),
    password: typeof p['password'] === 'string' ? p['password'] : '',
    hidden: p['hidden'] === true,
    eapMethod: typeof p['eapMethod'] === 'string' ? p['eapMethod'] : 'PEAP',
    phase2: typeof p['phase2'] === 'string' ? p['phase2'] : 'MSCHAPV2',
    identity: typeof p['identity'] === 'string' ? p['identity'] : '',
    anonymousIdentity: typeof p['anonymousIdentity'] === 'string' ? p['anonymousIdentity'] : '',
    name: typeof p['name'] === 'string' ? p['name'] : '',
    phone: typeof p['phone'] === 'string' ? p['phone'] : '',
    email: typeof p['email'] === 'string' ? p['email'] : '',
    org: typeof p['org'] === 'string' ? p['org'] : '',
    title: typeof p['title'] === 'string' ? p['title'] : '',
    vurl: qr?.type === 'vcard' && typeof p['url'] === 'string' ? p['url'] : '',
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

/**
 * A new short-link path as typed into the QR editor: trimmed, lowercased,
 * spaces and underscores to hyphens, empty segments dropped. Other characters
 * stay, for the route path rules to judge.
 */
export function normalizeQrRoutePath(path: string): string {
  const normalised = path
    .trim()
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .map(part => part.replace(/[ _]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('/');
  return normalised ? `/${normalised}` : '';
}

/**
 * The link the form would save, bound to `domain`: a selection made on
 * another domain never follows a domain change. Undefined for a code that is
 * not linked (or not a url code).
 */
export function linkedRouteFromState(s: QrFormState, domain: string): QRCode['linkedRoute'] {
  if (s.type !== 'url' || s.linkMode === 'static' || !isSupportedDomain(domain)) return undefined;
  if (s.linkMode === 'existing') {
    return s.linkedRoute?.domain === domain ? s.linkedRoute : undefined;
  }
  const path = normalizeQrRoutePath(s.newRoutePath);
  return path ? { domain, path } : undefined;
}

/** The short URL a linked code encodes. */
export function linkedRouteUrl(link: NonNullable<QRCode['linkedRoute']>): string {
  return `https://${link.domain}${link.path}`;
}

/** The payload the form saves: a linked code encodes its short URL. */
export function submittedPayload(s: QrFormState, domain: string): Record<string, unknown> {
  const link = linkedRouteFromState(s, domain);
  return link ? { url: linkedRouteUrl(link) } : payloadFromState(s);
}

/** The tags the form saves: comma-separated, trimmed, empty ones dropped. */
export function tagsFromState(s: QrFormState): string[] {
  return s.tags
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The update the QR edit dialog sends (v1.38.0): only the fields whose value,
 * as the form would save it, differs from what the form showed when it
 * opened. Both sides go through the same derivation, so a stored record the
 * form represents differently (an older record, an extra field) never counts
 * as a change, and a field the user did not touch is never sent: the Worker
 * applies today's limits only to the fields it is sent, so a code saved under
 * earlier limits stays editable. An unchanged form gives `{}`.
 *
 * `linkedRoute` is sent when the link changed: the new link, or `null` when a
 * url code is no longer linked.
 */
export function qrEditPatch(
  initial: QRCode,
  s: QrFormState,
  domain: string,
): Record<string, unknown> {
  const before = stateFromQr(initial);
  const patch: Record<string, unknown> = {};
  const payload = submittedPayload(s, domain);
  if (!sameJson(payload, submittedPayload(before, domain))) patch['payload'] = payload;
  const design = designFromState(s);
  if (!sameJson(design, designFromState(before))) patch['design'] = design;
  const description = s.description.trim();
  if (description !== before.description.trim()) patch['description'] = description;
  const tags = tagsFromState(s);
  if (!sameJson(tags, tagsFromState(before))) patch['tags'] = tags;
  if (s.type === 'url') {
    const link = linkedRouteFromState(s, domain) ?? null;
    // The stored link as it is, so clearing a link the form cannot show as
    // selected (one on another domain) is still sent
    const was = initial.linkedRoute ?? null;
    if (link?.domain !== was?.domain || link?.path !== was?.path) patch['linkedRoute'] = link;
  }
  return patch;
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
 * Suggested Reference for a not-yet-named QR (description decoupled).
 * Sourced from the type's most identifying payload field only.
 * Returns '' when there is nothing to go on yet, so the caller leaves the
 * field alone rather than writing a placeholder.
 */
export function suggestQrId(s: QrFormState): string {
  // Deliberately NOT sourced from the description: the Reference is
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
    default: {
      const unsupported: never = s.type;
      throw new Error(`Unsupported QR type: ${String(unsupported)}`);
    }
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
