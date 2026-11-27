/**
 * The one check for a Slack incoming-webhook URL (backup alerts, the feedback
 * notice): the value is used only when it is an https URL on host exactly
 * `hooks.slack.com`, with no port, no credentials and a `/services/` path.
 * Anything else is a misconfiguration, and the caller sends nothing.
 */
export function slackIncomingWebhook(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      url.port === '' &&
      url.pathname.startsWith('/services/') &&
      url.username === '' &&
      url.password === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}
