/**
 * Route UTM tracking (v1.38.0): the dashboard edits the five UTM tags of a
 * redirect or proxy target. Dashboard only — the API, the stored route and
 * the MCP tools see an ordinary target URL.
 */
export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/** Dialog label and tooltip for each UTM field: what it is for, with examples. */
export const UTM_FIELD_HELP: Record<UtmKey, { label: string; hint: string }> = {
  utm_source: {
    label: 'Source',
    hint: 'Where the visitor comes from: the site, platform, publication or partner. Examples: linkedin, newsletter, google, event-booklet.',
  },
  utm_medium: {
    label: 'Medium',
    hint: 'The type of channel that carried the link. Examples: email, social, cpc, qr, print, referral.',
  },
  utm_campaign: {
    label: 'Campaign',
    hint: 'The campaign, launch or event this link belongs to. Examples: spring-launch-2026, product-webinar, q4-newsletter.',
  },
  utm_term: {
    label: 'Term',
    hint: 'Mainly for paid search: the keyword you bid on. Can also tell audiences apart. Examples: running-shoes, gift-ideas, existing-customers.',
  },
  utm_content: {
    label: 'Content',
    hint: 'Which link or design was clicked when one campaign uses several. Examples: header-button, footer-link, banner-a, qr-back-cover.',
  },
};
// Missing key = untouched; empty/whitespace value = explicitly remove the key.
export type UtmValues = Partial<Record<UtmKey, string>>;

function targetParams(target: string): URLSearchParams | null {
  try {
    return new URL(target).searchParams;
  } catch {
    return null;
  }
}

/**
 * First value for each exact, case-sensitive UTM name, lowercased as it will be
 * saved; null for an invalid URL.
 */
export function parseUtm(target: string): UtmValues | null {
  const params = targetParams(target);
  if (!params) return null;
  const values: UtmValues = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value !== null) values[key] = value.toLowerCase();
  }
  return values;
}

/** UTM names with any target value that is not already lowercase; none for an invalid URL. */
export function uppercaseUtmKeys(target: string): UtmKey[] {
  const params = targetParams(target);
  return UTM_KEYS.filter(key => params?.getAll(key).some(value => value !== value.toLowerCase()));
}

/**
 * Apply explicit edits and save every UTM value in lowercase. A target value that
 * is not lowercase counts as an edit to its lowercased first value (parseUtm).
 * Validate with URL and encode/decode query pairs with URLSearchParams, but never
 * serialise the whole URL: that would rewrite unrelated encodings, duplicates,
 * empty separators, or even the URL's host. All occurrences of an edited key are
 * replaced by one trimmed lowercase value, or removed when cleared. Untouched
 * bytes (including fragments) are retained, so an unedited lowercase target is
 * returned unchanged. Throws TypeError for an invalid absolute URL, including on
 * a no-op.
 */
export function applyUtm(target: string, edits: UtmValues): string {
  const parsed = parseUtm(target);
  if (!parsed) throw new TypeError('Invalid absolute target URL');
  const values: UtmValues = {};
  for (const key of uppercaseUtmKeys(target)) values[key] = parsed[key];
  for (const key of UTM_KEYS) if (edits[key] !== undefined) values[key] = edits[key];
  const editedKeys = UTM_KEYS.filter(key => values[key] !== undefined);
  if (editedKeys.length === 0) return target;

  // Keep URL-parser-trimmed trailing whitespace outside the merged URL; placing
  // a new query after it would turn it into path/query data instead.
  // oxlint-disable-next-line no-control-regex -- Match the URL parser's trailing C0/space trim range.
  const raw = target.replace(/[\u0000-\u0020]+$/, '');
  const trailing = target.slice(raw.length);
  const hashIndex = raw.indexOf('#');
  const head = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex);
  const queryIndex = head.indexOf('?');
  const base = queryIndex === -1 ? head : head.slice(0, queryIndex);
  const pairs = queryIndex === -1 ? [] : head.slice(queryIndex + 1).split('&');
  const remaining = pairs.filter(pair => {
    // Prefix an empty pair so a literal leading '?' stays part of the key. The
    // URL parser ignores tabs and newlines, so a name split by them still matches.
    const key = new URLSearchParams(`&${pair.replace(/[\t\n\r]/g, '')}`).keys().next().value;
    return !editedKeys.includes(key as UtmKey);
  });
  for (const key of editedKeys) {
    const value = values[key]!.trim().toLowerCase();
    if (value) remaining.push(new URLSearchParams([[key, value]]).toString());
  }
  // Clearing an absent key must not normalise even an empty query marker.
  if (remaining.length === pairs.length && remaining.every((pair, i) => pair === pairs[i])) {
    return target;
  }
  return base + (remaining.length ? `?${remaining.join('&')}` : '') + fragment + trailing;
}
