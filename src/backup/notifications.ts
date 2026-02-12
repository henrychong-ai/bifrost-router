import type { BackupHealthResponse } from './health-schemas';

/**
 * Slack notification configuration
 */
export interface SlackNotificationConfig {
  /** Slack webhook URL */
  webhookUrl: string;
  /** Optional channel override */
  channel?: string;
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
  channel?: string;
  attachments: SlackAttachment[];
}

/**
 * Send backup health alert to Slack
 *
 * Only sends alerts for warning and critical statuses.
 * Healthy status is silently ignored.
 *
 * @param health - Backup health response
 * @param config - Slack notification configuration
 */
export async function sendBackupAlert(
  health: BackupHealthResponse,
  config: SlackNotificationConfig,
): Promise<void> {
  // Don't send alerts for healthy status
  if (health.status === 'healthy') return;

  // Color coding
  const color = health.status === 'critical' ? '#dc2626' : '#f59e0b';
  const emoji = health.status === 'critical' ? ':rotating_light:' : ':warning:';

  // Build message blocks
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Bifrost Backup ${health.status.toUpperCase()}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Status:*\n${health.status}`,
        },
        {
          type: 'mrkdwn',
          text: `*Last Backup:*\n${health.lastBackup?.date ?? 'None'}`,
        },
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

  // Add issues section if there are any
  if (health.issues.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Issues:*\n${health.issues.map(i => `• ${i.message}`).join('\n')}`,
      },
    });
  }

  // Build payload
  const payload: SlackPayload = {
    attachments: [
      {
        color,
        blocks,
      },
    ],
  };

  // Add channel if specified
  if (config.channel) {
    payload.channel = config.channel;
  }

  // Send to Slack
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error(`[Backup] Failed to send Slack alert: ${response.status} ${response.statusText}`);
  }
}
