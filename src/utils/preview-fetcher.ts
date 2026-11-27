/**
 * Recognise a link-preview fetcher (v1.48.0): the client a chat or social
 * platform sends to build the card for a shared link. Such a client gets a
 * route's preview document (`src/utils/link-preview.ts`); everyone else gets
 * the file.
 *
 * One precompiled, case-insensitive pattern over a curated list of product
 * tokens, plus a two-string test for Mastodon. Deliberately narrow: search
 * engines (Googlebot, Bingbot), AI crawlers (`meta-externalagent`, `meta-externalfetcher`, GPTBot), `curl`,
 * monitors, email scanners and the generic word "bot" are NOT on it and keep
 * receiving the file; no general bot library is used. A fetcher missing from
 * the list costs a bare link (today's behaviour), never a broken download.
 *
 * The user agent can be spoofed. That is acceptable because the document
 * only repeats public information the route's owner wrote for the card, and
 * a browser navigation (`Sec-Fetch-Mode: navigate` with
 * `Sec-Fetch-Dest: document`) always gets the file.
 *
 * List reviewed 24 November 2026 against each platform's published
 * documentation and user-agent strings:
 * - Apple iMessage sends a Safari 9 string ending
 *   `facebookexternalhit/1.1 Facebot Twitterbot/1.0`; it matches on purpose,
 *   by that ending, before the browser-navigation rule.
 * - Signal sends `WhatsApp/2`; it matches on purpose.
 * - Mastodon's card fetch is `… Mastodon/<version> (…) Bot`.
 */

/** The longest user agent matched; the rest is ignored, so a hostile agent costs nothing. */
export const PREVIEW_FETCHER_UA_MAX_LENGTH = 512;

/**
 * The fetchers recognised, in match order: the platform name and its token
 * pattern (a regular-expression source, matched case-insensitively). Every
 * token is a fixed string or anchored, so the one alternation is linear.
 * Loose app names are narrowed to the fetcher's own signature: Pinterest's
 * crawler (`Pinterestbot`, `Pinterest/0.`), Snapchat's `Snap URL Preview`,
 * and `WhatsApp/` only at the start of the agent (the preview fetcher and
 * Signal), never an in-app browser that mentions the app.
 */
export const PREVIEW_FETCHERS: readonly { platform: string; token: string }[] = [
  { platform: 'facebook', token: 'facebookexternalhit' },
  { platform: 'facebook', token: 'facebot' },
  { platform: 'whatsapp', token: '^whatsapp/' },
  { platform: 'linkedin', token: 'linkedinbot' },
  { platform: 'x', token: 'twitterbot' },
  { platform: 'slack', token: 'slackbot-linkexpanding' },
  { platform: 'discord', token: 'discordbot' },
  { platform: 'telegram', token: 'telegrambot' },
  { platform: 'teams', token: 'skypeuripreview' },
  { platform: 'bluesky', token: 'cardyb' },
  { platform: 'google-messages', token: 'googlemessages' },
  { platform: 'google-messages', token: 'google web preview' },
  { platform: 'iframely', token: 'iframely' },
  { platform: 'embedly', token: 'embedly' },
  { platform: 'pinterest', token: 'pinterestbot' },
  { platform: 'pinterest', token: 'pinterest/0\\.' },
  { platform: 'snapchat', token: 'snap url preview' },
];

/**
 * One alternation, each token its own capture group, compiled once. No `g`
 * flag: `exec` on a global pattern keeps `lastIndex` between calls.
 */
const PREVIEW_FETCHER_PATTERN = new RegExp(
  PREVIEW_FETCHERS.map(({ token }) => `(${token})`).join('|'),
  'i',
);

/**
 * Apple's Messages link-preview fetcher: its Safari 9 agent ends with both
 * Facebook's and X's crawler names (`… facebookexternalhit/1.1 Facebot
 * Twitterbot/1.0`). Matched as the END of the trimmed, lower-cased agent, and
 * recognised before the browser rule: Apple's fetcher runs on WebKit.
 */
const APPLE_MESSAGES_SIGNATURE = 'facebookexternalhit/1.1 facebot twitterbot/1.0';

/**
 * Mastodon's card fetch, `http.rb/… (Mastodon/<version>; +<instance>) Bot`:
 * two plain string tests instead of a backtracking pattern.
 */
function isMastodonCardFetch(lowerCaseAgent: string): boolean {
  return lowerCaseAgent.includes('mastodon/') && lowerCaseAgent.endsWith(' bot');
}

/**
 * A browser navigation: `Sec-Fetch-Mode: navigate` AND `Sec-Fetch-Dest:
 * document`, which a person's click on a link sends and no link-preview
 * fetcher does. Either header alone is not enough: fetchers built on a
 * browser engine or a Fetch-spec client send some Fetch Metadata headers.
 */
function isBrowserNavigation(headers: Headers): boolean {
  return (
    headers.get('sec-fetch-mode')?.toLowerCase() === 'navigate' &&
    headers.get('sec-fetch-dest')?.toLowerCase() === 'document'
  );
}

/**
 * The platform whose link-preview fetcher sent `headers`, or null: for an
 * empty or missing user agent, a browser navigation, or any agent not on the
 * list. Apple's Messages fetcher is recognised first, by the end of its
 * whole trimmed agent; the token scan reads only the first
 * PREVIEW_FETCHER_UA_MAX_LENGTH characters.
 */
export function detectPreviewFetcher(headers: Headers): string | null {
  const fullAgent = headers.get('user-agent') ?? '';
  // Apple's signature is the END of the whole agent: only that tail is
  // lower-cased and compared, never more of a long agent
  const ending = fullAgent.trimEnd().slice(-APPLE_MESSAGES_SIGNATURE.length).toLowerCase();
  if (ending === APPLE_MESSAGES_SIGNATURE) return 'imessage';
  const userAgent = fullAgent.slice(0, PREVIEW_FETCHER_UA_MAX_LENGTH);
  const lower = userAgent.trim().toLowerCase();
  if (lower === '') return null;
  if (isBrowserNavigation(headers)) return null;
  const match = PREVIEW_FETCHER_PATTERN.exec(userAgent);
  if (match) {
    const index = match.slice(1).findIndex(group => group !== undefined);
    return PREVIEW_FETCHERS[index]?.platform ?? null;
  }
  return isMastodonCardFetch(lower) ? 'mastodon' : null;
}
