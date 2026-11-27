/**
 * Backup alerting: one Slack message when the nightly backup fails, or when
 * the health check after a successful run is not healthy.
 *
 * Optional and dormant by default. It acts only when the Worker secret
 * `BACKUP_ALERT_SLACK_WEBHOOK` is set; unset, it is a silent no-op (no health
 * check, no request, no log line), like the other optional features that ship
 * off. An alert carries counts and fixed texts only, never a key, a stored
 * value, the manifest's domain list or an error message, and the Worker never
 * writes the webhook URL to its logs. Workers traces, when enabled, still record
 * it as the URL of the outbound request (README "Optional: Backup failure
 * alerts").
 */

import type { Bindings } from '../types';
import { errorName } from '../utils/error-name';
import { slackIncomingWebhook } from '../utils/slack-webhook';
import { checkBackupHealth } from './health';
import type { BackupHealthResponse } from './health-schemas';
import { isFixedBackupFailureText } from './integrity';
import type { BackupResult } from './types';

/**
 * Slack notification configuration
 */
interface SlackNotificationConfig {
  /** Slack incoming-webhook URL, already checked by backupAlertWebhook */
  webhookUrl: string;
  /** Environment label shown in the alert, when it is a known one */
  environment?: 'production' | 'development' | undefined;
}

/**
 * Slack block for message formatting
 */
interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
}

/**
 * Slack attachment for rich messaging
 */
interface SlackAttachment {
  color: string;
  blocks: SlackBlock[];
}

/**
 * Slack message payload
 */
interface SlackPayload {
  /** Plain-text fallback for notifications and clients without attachments */
  text: string;
  attachments: SlackAttachment[];
}

/** How long one alert delivery may take. */
export const ALERT_TIMEOUT_MS = 10_000;

/**
 * How long the health check after a backup may take before it is treated as
 * unavailable (critical alert): a stalled R2 read must not hold the cron.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 60_000;

/** The health check after a backup passed HEALTH_CHECK_TIMEOUT_MS. */
export class HealthCheckTimeoutError extends Error {
  constructor() {
    super('Backup health check timed out');
    this.name = 'HealthCheckTimeoutError';
  }
}

/**
 * The reason a failed backup's alert gives when the backup's error is not one
 * of the fixed failure texts (`isFixedBackupFailureText`): any other text
 * could quote a stored value.
 */
export const BACKUP_FAILURE_UNSPECIFIED =
  'Unexpected error (details in the [Backup] or [Scheduled] log)';

/** The issue reported when the health check after a backup throws or times out. */
export const HEALTH_CHECK_UNAVAILABLE = 'Backup health check could not run after the backup';

/**
 * What notifyBackupOutcome returns while the webhook is unset. It is never
 * logged: an unconfigured optional feature stays silent.
 */
export const BACKUP_ALERT_NOT_CONFIGURED = 'Backup alert not configured';

/** Every line the alerting step logs: fixed texts, never the webhook URL. */
export const BACKUP_ALERT_LOG = {
  invalidWebhook: '[Backup] Alert not sent: BACKUP_ALERT_SLACK_WEBHOOK is not a Slack webhook URL',
  healthy: '[Backup] Health check after backup: healthy; no alert',
  sent: '[Backup] Alert sent',
  failed: '[Backup] Alert failed',
  healthCheckFailed: '[Backup] Health check after backup could not run',
} as const;

/** The reason text for a failed backup's alert. */
export function backupFailureReason(error: string | undefined): string {
  return isFixedBackupFailureText(error) ? error : BACKUP_FAILURE_UNSPECIFIED;
}

/**
 * The webhook, only if it is an https Slack incoming-webhook URL: host exactly
 * `hooks.slack.com`, no port, no credentials, a `/services/` path.
 */
export function backupAlertWebhook(value: unknown): string | null {
  return slackIncomingWebhook(value);
}

/** The environment label, only when it is one of the two known values. */
function environmentLabel(value: unknown): SlackNotificationConfig['environment'] {
  return value === 'production' || value === 'development' ? value : undefined;
}

/** Environment field (when known) and plain-text fallback. */
function finishPayload(
  text: string,
  color: string,
  blocks: SlackBlock[],
  config: SlackNotificationConfig,
): SlackPayload {
  if (config.environment) {
    blocks[1]?.fields?.push({ type: 'mrkdwn', text: `*Environment:*\n${config.environment}` });
  }
  return {
    text: config.environment ? `${text} (${config.environment})` : text,
    attachments: [{ color, blocks }],
  };
}

/**
 * The Slack payload for a warning or critical health report. Every value in
 * it is a status, a date, a count or a fixed issue message (health issues
 * carry counts and fixed texts only, never a stored value).
 */
function buildHealthPayload(
  health: BackupHealthResponse,
  config: SlackNotificationConfig,
): SlackPayload {
  const color = health.status === 'critical' ? '#dc2626' : '#f59e0b';
  const emoji = health.status === 'critical' ? ':rotating_light:' : ':warning:';
  const status = health.status.toUpperCase();

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} Bifrost Backup ${status}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:*\n${health.status}` },
        { type: 'mrkdwn', text: `*Last Backup:*\n${health.lastBackup?.date ?? 'None'}` },
        {
          type: 'mrkdwn',
          text: `*Age:*\n${health.lastBackup?.ageHours.toFixed(1) ?? 'N/A'} hours`,
        },
        {
          type: 'mrkdwn',
          text: `*Routes:*\n${health.lastBackup?.manifest?.kv.totalRoutes ?? 'N/A'}`,
        },
      ],
    },
  ];

  if (health.issues.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Issues:*\n${health.issues.map(i => `• ${i.message}`).join('\n')}`,
      },
    });
  }

  return finishPayload(`Bifrost backup ${status}`, color, blocks, config);
}

/** The Slack payload for a backup run that failed. */
function buildFailurePayload(reason: string, config: SlackNotificationConfig): SlackPayload {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':rotating_light: Bifrost Backup FAILED', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Status:*\nfailed' },
        { type: 'mrkdwn', text: `*Reason:*\n${reason}` },
      ],
    },
  ];
  return finishPayload('Bifrost backup FAILED', '#dc2626', blocks, config);
}

/** The report used when the health check after a backup cannot run. */
function unavailableHealth(): BackupHealthResponse {
  return {
    status: 'critical',
    timestamp: new Date().toISOString(),
    lastBackup: null,
    issues: [{ severity: 'critical', message: HEALTH_CHECK_UNAVAILABLE }],
    checks: {
      backupExists: false,
      backupAge: 'critical',
      manifestValid: false,
      filesComplete: false,
      routeCountOk: false,
      contentVerified: false,
    },
  };
}

/** `check`, or a HealthCheckTimeoutError once HEALTH_CHECK_TIMEOUT_MS passes. */
async function withHealthTimeout<T>(check: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthCheckTimeoutError()), HEALTH_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST one payload. Redirects are not followed (a redirect could carry the
 * request elsewhere; a 3xx counts as a failed delivery) and the call gives up
 * after ALERT_TIMEOUT_MS. The response body is discarded unread. A network
 * failure or timeout throws.
 */
async function postSlack(webhookUrl: string, payload: SlackPayload): Promise<Response> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await response.body?.cancel().catch(() => undefined);
  return response;
}

type HealthCheck = (bucket: R2Bucket) => Promise<BackupHealthResponse>;

/**
 * Alert on the nightly backup's outcome. Called by the backup cron after
 * `handleScheduled`; never throws, and returns the line it logged (or
 * BACKUP_ALERT_NOT_CONFIGURED, logged nowhere).
 *
 * Dormant until configured: with no `BACKUP_ALERT_SLACK_WEBHOOK` it does
 * nothing at all (no health check, no request, no log line). A value that is
 * not a Slack incoming-webhook URL logs one fixed line and sends nothing. When
 * set:
 *  - a failed run sends ONE "FAILED" alert whose reason is a fixed failure
 *    text or a fixed placeholder (`backupFailureReason`);
 *  - a successful run is followed by the same health check as
 *    `GET /api/backups/health`, and a warning or critical result sends ONE
 *    alert with the status, date, age, route count and the fixed issue
 *    messages (this includes the skipped-record issues); a healthy result
 *    sends nothing. A health check that throws, or takes longer than
 *    HEALTH_CHECK_TIMEOUT_MS, sends a critical alert with
 *    `HEALTH_CHECK_UNAVAILABLE` and logs the error class only.
 * A delivery failure logs a fixed line (with the HTTP status when there was a
 * response) and never changes the cron outcome.
 */
export async function notifyBackupOutcome(
  env: Bindings,
  result: BackupResult,
  checkHealth: HealthCheck = checkBackupHealth,
): Promise<string> {
  if (!env.BACKUP_ALERT_SLACK_WEBHOOK) return BACKUP_ALERT_NOT_CONFIGURED;
  const webhookUrl = backupAlertWebhook(env.BACKUP_ALERT_SLACK_WEBHOOK);
  if (!webhookUrl) return warn(BACKUP_ALERT_LOG.invalidWebhook);
  const config: SlackNotificationConfig = {
    webhookUrl,
    environment: environmentLabel(env.ENVIRONMENT),
  };

  let payload: SlackPayload;
  if (!result.success || !env.BACKUP_BUCKET) {
    payload = buildFailurePayload(backupFailureReason(result.error), config);
  } else {
    let health: BackupHealthResponse;
    try {
      health = await withHealthTimeout(checkHealth(env.BACKUP_BUCKET));
    } catch (error) {
      console.error(`${BACKUP_ALERT_LOG.healthCheckFailed}: ${errorName(error)}`);
      health = unavailableHealth();
    }
    if (health.status === 'healthy') {
      console.log(BACKUP_ALERT_LOG.healthy);
      return BACKUP_ALERT_LOG.healthy;
    }
    payload = buildHealthPayload(health, config);
  }

  try {
    const response = await postSlack(config.webhookUrl, payload);
    if (!response.ok) return warn(`${BACKUP_ALERT_LOG.failed} (HTTP ${response.status})`);
  } catch {
    // The error can carry the URL: never printed
    return warn(BACKUP_ALERT_LOG.failed);
  }
  console.log(BACKUP_ALERT_LOG.sent);
  return BACKUP_ALERT_LOG.sent;
}

function warn(line: string): string {
  console.warn(line);
  return line;
}
