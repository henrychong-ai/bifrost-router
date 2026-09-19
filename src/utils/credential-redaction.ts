/**
 * Credential policy v2. Vendored byte-identically; see credential-redaction.json.
 * Inspect at most two decoded views, never recursively rebuild nested URLs.
 * Ordinary fields retain their bytes; suspicious fields lose their whole value.
 * This is credential-name detection, not proof that arbitrary text is secret.
 */
export const REDACTED = '[redacted]';
export const MAX_CREDENTIAL_INPUT = 16_384;
const OPAQUE = 'uninspectable input';
const SAFE_NAME = /^[a-z][a-z0-9_.[\]-]{0,63}$/i;
const EXACT = /^(?:code|key|auth|sig|session|state|ticket|api[-_]?key|code_verifier)(?:\[\d*\])?$/i;
const STEM =
  /token|secret|passw|credential|assert|saml|signature|jwt|otp|ticket|nonce|oob|^x-amz-/i;

// Only recognised labels may be echoed. An ambiguous nested token could itself
// be a credential, so unknown compound names receive a fixed warning label.
const KNOWN_NAMES = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'session_token',
  'client_secret',
  'password',
  'secret',
  'nonce',
  'jwt',
  'otp',
  'samlresponse',
  'x-amz-signature',
  'x-amz-algorithm',
  'x-amz-date',
  'x-amz-credential',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-signedheaders',
  'code_verifier',
  'oauth.state',
  'stytch_token',
  'token_hash',
  'oobcode',
  'oauth_token',
]);
const reportableName = (name: string): boolean =>
  EXACT.test(name) || KNOWN_NAMES.has(name.toLowerCase());

function sensitiveName(name: string): boolean {
  return STEM.test(name) || name.split('.').some((part) => EXACT.test(part));
}

/** Bounds both work and decoding. Uninspectable input fails closed. */
function decodedViews(text: string): string[] | null {
  if (text.length > MAX_CREDENTIAL_INPUT) return null;
  const views: string[] = [];
  for (let depth = 0; depth < 3; depth++) {
    text = text.replace(/[\t\n\r]/g, '');
    views.push(text);
    if (!/%[0-9a-f]{2}/i.test(text)) return views;
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }
  return null;
}

/** Names only, never values. Opaque inputs get a fixed, non-sensitive label. */
export function findCredentialParams(text: string): string[] {
  const views = decodedViews(text);
  if (!views) return [OPAQUE];
  const names = new Set<string>();
  for (const view of views) {
    if (/\/\/[^/?#]*@/.test(view)) names.add('URL credentials');
    // Delimiters are inspection boundaries only, never reconstruction rules.
    for (const match of view.matchAll(/([^?&#;/=]*)([?&#;/=]|$)/g)) {
      if (match[2] === '' || match[2] === '&') continue;
      const name = match[1].trim();
      if (sensitiveName(name)) {
        names.add(
          (match[2] === '=' || match[2] === '?') && reportableName(name)
            ? name
            : 'credential-like field',
        );
      }
    }
  }
  return [...names];
}

export function redactSensitiveQueryValues(search: string): string | null {
  if (!search) return null;
  if (search.length > MAX_CREDENTIAL_INPUT) return `?${REDACTED}`;
  const query = search.startsWith('?') ? search.slice(1) : search;
  return `?${query
    .split('&')
    .map((field) => {
      if (findCredentialParams(field).length === 0) return field;
      const equals = field.indexOf('=');
      const name = field.slice(0, equals);
      // Unusual/encoded names can themselves carry secrets; keep only plain names.
      return equals >= 0 && SAFE_NAME.test(name) && (!sensitiveName(name) || reportableName(name))
        ? `${name}=${REDACTED}`
        : REDACTED;
    })
    .join('&')}`;
}

/** Stored copy only. A suspicious path or fragment masks the entire URL. */
export function redactRouteTarget(target: string): string {
  const hash = target.indexOf('#');
  const beforeHash = hash < 0 ? target : target.slice(0, hash);
  const query = beforeHash.indexOf('?');
  const head = query < 0 ? beforeHash : beforeHash.slice(0, query);
  const fragment = hash < 0 ? '' : target.slice(hash);
  if (target.length > MAX_CREDENTIAL_INPUT || findCredentialParams(head + fragment).length) {
    return REDACTED;
  }
  return head + (query < 0 ? '' : redactSensitiveQueryValues(beforeHash.slice(query))) + fragment;
}

/** Legacy names remain adapters, not a second policy. */
export function legacyQueryString(url: URL): string | null {
  return redactSensitiveQueryValues(url.search);
}

export function legacyReferrer(referrer: string | undefined): string | undefined {
  return referrer === undefined ? undefined : redactRouteTarget(referrer);
}

/** Route snapshots in audit metadata must not create extra credential copies. */
export function redactAuditDetails(details: string | null | undefined): string | null {
  if (details == null) return null;
  try {
    return JSON.stringify(
      JSON.parse(details, (key, value: unknown) =>
        ['target', 'targetUrl', 'target_url'].includes(key) && typeof value === 'string'
          ? redactRouteTarget(value)
          : value,
      ),
    );
  } catch {
    // Unstructured metadata cannot be safely interpreted as a route snapshot.
    return REDACTED;
  }
}
