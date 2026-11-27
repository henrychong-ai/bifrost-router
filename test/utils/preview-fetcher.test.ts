/**
 * The link-preview fetcher detector (v1.48.0), against real user-agent
 * strings. Only the curated fetchers match; browsers, search engines, AI
 * crawlers, curl and in-app browsers keep receiving the file. Two agents
 * carry a contact address, written here as an example-domain address; the
 * detection keys on the product token, never on the address.
 */
import { describe, expect, it } from 'vitest';
import {
  detectPreviewFetcher,
  PREVIEW_FETCHER_UA_MAX_LENGTH,
  PREVIEW_FETCHERS,
} from '../../src/utils/preview-fetcher';

const headers = (userAgent: string | null, extra: Record<string, string> = {}) => {
  const h = new Headers(extra);
  if (userAgent !== null) h.set('User-Agent', userAgent);
  return h;
};

const FETCHERS: [string, string, string][] = [
  [
    'Facebook',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'facebook',
  ],
  ['Facebot', 'Facebot', 'facebook'],
  ['WhatsApp', 'WhatsApp/2.23.20.0 A', 'whatsapp'],
  ['Signal', 'WhatsApp/2', 'whatsapp'],
  [
    'iMessage',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
    'imessage',
  ],
  [
    'LinkedIn',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'linkedin',
  ],
  ['X', 'Twitterbot/1.0', 'x'],
  ['Slack', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'slack'],
  ['Discord', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'discord'],
  ['Telegram', 'TelegramBot (like TwitterBot)', 'telegram'],
  [
    'Teams',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 preview-bot@example.com',
    'teams',
  ],
  ['Bluesky', 'Mozilla/5.0 (compatible; Cardyb/1.1; +mailto:preview-bot@example.com)', 'bluesky'],
  ['Mastodon', 'http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/) Bot', 'mastodon'],
  [
    'Google Messages',
    'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/90 Mobile GoogleMessages',
    'google-messages',
  ],
  [
    'Google Web Preview',
    'Mozilla/5.0 (en-us) AppleWebKit/534.14 (KHTML, like Gecko; Google Web Preview) Chrome/9.0.597 Safari/534.14',
    'google-messages',
  ],
  ['Iframely', 'Iframely/1.3.1 (+https://iframely.com/docs/about) Atlassian', 'iframely'],
  ['Embedly', 'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)', 'embedly'],
  ['Pinterest', 'Pinterest/0.2 (+https://www.pinterest.com/bot.html)', 'pinterest'],
  [
    'Pinterestbot',
    'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)',
    'pinterest',
  ],
  [
    'Snapchat',
    'Mozilla/5.0 (compatible; Snap URL Preview Service; bot; snapchat; https://developers.snap.com/robots)',
    'snapchat',
  ],
];

const NOT_FETCHERS: [string, string][] = [
  [
    'Chrome',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ],
  [
    'Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ],
  ['Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'],
  ['curl', 'curl/8.7.1'],
  ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  [
    'Meta AI crawler',
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  ],
  ['Meta AI fetcher', 'meta-externalfetcher/1.1'],
  [
    'Instagram in-app browser',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101',
  ],
  [
    'Facebook in-app browser',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/490.0.0.38.109]',
  ],
  ['a generic bot', 'SomeMonitorBot/1.0'],
  ['Mastodon without the Bot suffix', 'http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)'],
  ['whitespace only', '   '],
  [
    'Snapchat Android in-app WebView',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 Snapchat/13.20.0.43 (like Gecko)',
  ],
  [
    'Pinterest iOS in-app browser',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]',
  ],
  [
    'an in-app browser mentioning WhatsApp mid-agent',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 WhatsApp/24.1',
  ],
  ['Mastodon with Bot not at the end', 'http.rb/5.1.1 (Mastodon/4.2.0) Bot extra'],
];

describe('detectPreviewFetcher (v1.48.0)', () => {
  it.each(FETCHERS)('%s is a fetcher', (_label, userAgent, platform) => {
    expect(detectPreviewFetcher(headers(userAgent))).toBe(platform);
  });

  it.each(NOT_FETCHERS)('%s is not a fetcher', (_label, userAgent) => {
    expect(detectPreviewFetcher(headers(userAgent))).toBeNull();
  });

  it('an empty or missing user agent is not a fetcher', () => {
    expect(detectPreviewFetcher(headers(''))).toBeNull();
    expect(detectPreviewFetcher(headers(null))).toBeNull();
  });

  it('matches case-insensitively and gives the same answer on every call (no g flag)', () => {
    for (let i = 0; i < 5; i++) {
      expect(detectPreviewFetcher(headers('LINKEDINBOT/1.0'))).toBe('linkedin');
    }
  });

  it('a browser navigation (navigate AND document) is never a fetcher, whatever its agent says', () => {
    const navigation = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    for (const [name, userAgent] of FETCHERS) {
      if (name === 'iMessage') continue;
      expect(detectPreviewFetcher(headers(userAgent, navigation))).toBeNull();
    }
    // Header values are compared case-insensitively
    expect(
      detectPreviewFetcher(
        headers('LinkedInBot/1.0', { 'Sec-Fetch-Mode': 'NAVIGATE', 'Sec-Fetch-Dest': 'Document' }),
      ),
    ).toBeNull();
  });

  it('other Fetch Metadata headers never exclude a fetcher (engine-built fetchers send them)', () => {
    for (const metadata of [
      { 'Sec-Fetch-Mode': 'navigate' },
      { 'Sec-Fetch-Dest': 'document' },
      { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'video' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'none' },
    ]) {
      for (const [, userAgent, platform] of FETCHERS) {
        expect(detectPreviewFetcher(headers(userAgent, metadata))).toBe(platform);
      }
    }
  });

  it("Apple's Messages fetcher is recognised by the end of its agent, before the navigation rule", () => {
    const appleMessages =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0';
    const navigation = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    expect(detectPreviewFetcher(headers(appleMessages, navigation))).toBe('imessage');
    expect(detectPreviewFetcher(headers(`  ${appleMessages.toUpperCase()}  `))).toBe('imessage');
    // The signature anywhere but the end is not Apple's fetcher: a navigation stays a browser
    expect(detectPreviewFetcher(headers(`${appleMessages} Extra/1.0`, navigation))).toBeNull();
    expect(
      detectPreviewFetcher(
        headers('Mozilla/5.0 (iPhone) Safari/604.1 facebookexternalhit/1.1', navigation),
      ),
    ).toBeNull();
  });

  it("Apple's signature is read from the end of the whole agent, not the 512-character slice", () => {
    const signature = 'facebookexternalhit/1.1 Facebot Twitterbot/1.0';
    const long = `Mozilla/5.0 ${'x'.repeat(600)} ${signature}`;
    expect(long.length).toBeGreaterThan(512);
    expect(detectPreviewFetcher(headers(`${long}  `))).toBe('imessage');
    // The 512th character ends the signature, but the agent goes on: not Apple's
    const head = `${'y'.repeat(512 - signature.length - 1)} ${signature}`;
    expect(head.length).toBe(512);
    expect(
      detectPreviewFetcher(
        headers(`${head} Continues/1.0`, {
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        }),
      ),
    ).toBeNull();
  });

  it('reads only the first 512 characters, and a 120 KB hostile agent returns quickly', () => {
    expect(PREVIEW_FETCHER_UA_MAX_LENGTH).toBe(512);
    expect(detectPreviewFetcher(headers(`${'x'.repeat(600)} LinkedInBot/1.0`))).toBeNull();
    const hostile = `Mastodon/${' '.repeat(120 * 1024)}x`;
    const started = performance.now();
    expect(detectPreviewFetcher(headers(hostile))).toBeNull();
    const spaced = `Mastodon/1 ${'a '.repeat(60 * 1024)}`;
    expect(detectPreviewFetcher(headers(spaced))).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('every listed token is exercised by the table above', () => {
    const platforms = new Set(FETCHERS.map(([, , platform]) => platform));
    for (const { platform } of PREVIEW_FETCHERS) expect(platforms.has(platform)).toBe(true);
  });
});
