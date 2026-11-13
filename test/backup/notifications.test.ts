import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_BUCKET_NOT_CONFIGURED,
  BACKUP_LISTING_CURSOR_INVALID,
} from '../../src/backup/constants';
import type { BackupHealthResponse } from '../../src/backup/health-schemas';
import {
  BACKUP_ERRORS,
  BACKUP_FAILED_GENERIC,
  BackupReadError,
  isFixedBackupFailureText,
} from '../../src/backup/integrity';
import {
  ALERT_TIMEOUT_MS,
  BACKUP_ALERT_LOG,
  BACKUP_ALERT_NOT_CONFIGURED,
  BACKUP_FAILURE_UNSPECIFIED,
  backupAlertWebhook,
  backupFailureReason,
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_CHECK_UNAVAILABLE,
  notifyBackupOutcome,
} from '../../src/backup/notifications';
import type { Bindings } from '../../src/types';

/** A placeholder in the incoming-webhook shape; no such hook exists. */
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/fixture-only';
const ok = { success: true, duration: 5, manifest: undefined } as const;
const bucket = {} as R2Bucket;
const baseEnv = { ENVIRONMENT: 'production', BACKUP_BUCKET: bucket } as unknown as Bindings;
const withHook = (extra: Partial<Bindings> = {}) =>
  ({ ...baseEnv, BACKUP_ALERT_SLACK_WEBHOOK: WEBHOOK, ...extra }) as Bindings;
const health = (status: BackupHealthResponse['status']): BackupHealthResponse => ({
  status,
  timestamp: '2026-09-19T00:00:00Z',
  lastBackup: null,
  issues: [],
  checks: {
    backupExists: false,
    backupAge: 'critical',
    manifestValid: false,
    filesComplete: false,
    routeCountOk: false,
  },
});

type HealthCheck = (bucket: R2Bucket) => Promise<BackupHealthResponse>;

/** `url` with a user name and password in its authority. */
function withCredentials(url: string): string {
  const parsed = new URL(url);
  parsed.username = 'user';
  parsed.password = 'pw';
  return parsed.href;
}

/** A failed run's result with `error` as its failure text. */
const failed = (error?: string) => ({ success: false, error, duration: 1 });

/** The one request sent: checks how it was sent and returns its payload. */
function sentPayload() {
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
  expect(url).toBe(WEBHOOK);
  expect(init?.method).toBe('POST');
  expect(init?.redirect).toBe('manual');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(ALERT_TIMEOUT_MS);
  return JSON.parse(String(init?.body));
}

describe('backup health alert formatting', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('ok')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not send healthy reports', async () => {
    await notifyBackupOutcome(
      withHook(),
      ok,
      vi.fn<HealthCheck>().mockResolvedValue(health('healthy')),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends critical missing-backup details and issues', async () => {
    const report = {
      ...health('critical'),
      issues: [{ severity: 'critical' as const, message: 'No backup found in R2 bucket' }],
    };
    await notifyBackupOutcome(
      withHook({ ENVIRONMENT: 'other' as never }),
      ok,
      vi.fn<HealthCheck>().mockResolvedValue(report),
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK);
    expect(init?.method).toBe('POST');
    const payload = JSON.parse(String(init?.body));
    expect(payload).not.toHaveProperty('channel');
    expect(payload.attachments[0].color).toBe('#dc2626');
    expect(
      payload.attachments[0].blocks[1].fields.map((field: { text: string }) => field.text),
    ).toEqual([
      '*Status:*\ncritical',
      '*Last Backup:*\nNone',
      '*Age:*\nN/A hours',
      '*Routes:*\nN/A',
    ]);
    expect(payload.attachments[0].blocks[2].text.text).toBe(
      '*Issues:*\n• No backup found in R2 bucket',
    );
  });

  it.each([
    null,
    { version: '2.0.0', date: '20260918', kv: { totalRoutes: 123, domains: ['example.com'] } },
  ])('formats warning backup data with manifest %j', async manifest => {
    const report = {
      ...health('warning'),
      lastBackup: {
        date: '20260918',
        timestamp: '2026-09-18T00:00:00Z',
        ageHours: 25.25,
        manifest,
        files: [],
        archive: null,
      },
    } as unknown as BackupHealthResponse;
    await notifyBackupOutcome(withHook(), ok, vi.fn<HealthCheck>().mockResolvedValue(report));
    const body = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    // The manifest's domain list never reaches the alert
    expect(body).not.toContain('example.com');
    const payload = JSON.parse(body);
    expect(payload.attachments[0].color).toBe('#f59e0b');
    expect(payload.attachments[0].blocks).toHaveLength(2);
    expect(payload.attachments[0].blocks[1].fields.map((f: { text: string }) => f.text)).toEqual([
      '*Status:*\nwarning',
      '*Last Backup:*\n20260918',
      '*Age:*\n25.3 hours',
      `*Routes:*\n${manifest ? '123' : 'N/A'}`,
      '*Environment:*\nproduction',
    ]);
  });
});

describe('notifyBackupOutcome', () => {
  let logs: string[];

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('ok')));
    logs = [];
    for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    vi.spyOn(AbortSignal, 'timeout');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const noUrlLogged = () => {
    for (const line of logs) expect(line).not.toContain('hooks.slack.com');
  };

  it('is a silent no-op while the webhook is unset: no health check, no request, no log', async () => {
    const check = vi.fn<HealthCheck>();
    for (const env of [baseEnv, withHook({ BACKUP_ALERT_SLACK_WEBHOOK: '' })]) {
      for (const result of [ok, failed('x')]) {
        expect(await notifyBackupOutcome(env, result, check)).toBe(BACKUP_ALERT_NOT_CONFIGURED);
      }
    }
    expect(check).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it.each([
    'http://hooks.slack.com/services/T/B/x',
    'https://hooks.slack.com.evil.example/services/T/B/x',
    'https://evil.example/services/T/B/x',
    'https://hooks.slack.com/api/x',
    withCredentials(WEBHOOK),
    'https://hooks.slack.com:8443/services/T/B/x',
    'not a url',
  ])('refuses a webhook that is not a Slack incoming webhook: %s', async value => {
    const check = vi.fn<HealthCheck>();
    expect(
      await notifyBackupOutcome(withHook({ BACKUP_ALERT_SLACK_WEBHOOK: value }), ok, check),
    ).toBe(BACKUP_ALERT_LOG.invalidWebhook);
    expect(check).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual([BACKUP_ALERT_LOG.invalidWebhook]);
    for (const line of logs) expect(line).not.toContain(value);
  });

  it('accepts only a Slack incoming-webhook URL', () => {
    expect(backupAlertWebhook(WEBHOOK)).toBe(WEBHOOK);
    expect(backupAlertWebhook(undefined)).toBeNull();
    expect(backupAlertWebhook('')).toBeNull();
    expect(backupAlertWebhook(42)).toBeNull();
  });

  it('alerts on a failed backup with its fixed failure text', async () => {
    const result = failed(BACKUP_ERRORS.countMismatch);
    expect(await notifyBackupOutcome(withHook(), result, vi.fn<HealthCheck>())).toBe(
      BACKUP_ALERT_LOG.sent,
    );
    const payload = sentPayload();
    expect(payload.text).toBe('Bifrost backup FAILED (production)');
    const attachment = payload.attachments[0];
    expect(attachment.color).toBe('#dc2626');
    expect(attachment.blocks[0].text.text).toBe(':rotating_light: Bifrost Backup FAILED');
    expect(attachment.blocks[1].fields.map((f: { text: string }) => f.text)).toEqual([
      '*Status:*\nfailed',
      '*Reason:*\nBackup record count does not match',
      '*Environment:*\nproduction',
    ]);
    expect(logs).toEqual([BACKUP_ALERT_LOG.sent]);
    noUrlLogged();
  });

  it.each([
    ...Object.values(BACKUP_ERRORS),
    BACKUP_FAILED_GENERIC,
    BACKUP_LISTING_CURSOR_INVALID,
    BACKUP_BUCKET_NOT_CONFIGURED,
    new BackupReadError(new Error('x')).message,
  ])('passes the fixed failure text "%s" through as the reason', error => {
    expect(isFixedBackupFailureText(error)).toBe(true);
    expect(backupFailureReason(error)).toBe(error);
  });

  it.each([
    'Unexpected token in JSON: {"password":"hunter2"}',
    'Backup listing cursor invalid: cursor=abc',
    undefined,
  ])('never puts a non-fixed error in the alert: %s', async error => {
    await notifyBackupOutcome(
      withHook({ ENVIRONMENT: 'development' }),
      failed(error),
      vi.fn<HealthCheck>(),
    );
    const body = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('cursor=abc');
    const payload = JSON.parse(body);
    expect(payload.text).toBe('Bifrost backup FAILED (development)');
    expect(payload.attachments[0].blocks[1].fields[1].text).toBe(
      `*Reason:*\n${BACKUP_FAILURE_UNSPECIFIED}`,
    );
    expect(isFixedBackupFailureText(error)).toBe(false);
    expect(backupFailureReason(error)).toBe(BACKUP_FAILURE_UNSPECIFIED);
  });

  it('alerts as failed when the bucket is unbound even on a reported success', async () => {
    const check = vi.fn<HealthCheck>();
    await notifyBackupOutcome(withHook({ BACKUP_BUCKET: undefined }), ok, check);
    expect(check).not.toHaveBeenCalled();
    expect(sentPayload().text).toBe('Bifrost backup FAILED (production)');
  });

  it('checks health after a successful backup and sends nothing when healthy', async () => {
    const check = vi.fn<HealthCheck>().mockResolvedValue(health('healthy'));
    expect(await notifyBackupOutcome(withHook(), ok, check)).toBe(BACKUP_ALERT_LOG.healthy);
    expect(check).toHaveBeenCalledWith(bucket);
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual([BACKUP_ALERT_LOG.healthy]);
  });

  it('alerts on an unhealthy backup, including the skipped-record warning', async () => {
    const warning = {
      ...health('warning'),
      issues: [
        {
          severity: 'warning' as const,
          message: '2 stored records are not JSON and were not backed up',
        },
      ],
    };
    const check = vi.fn<HealthCheck>().mockResolvedValue(warning);
    expect(await notifyBackupOutcome(withHook({ ENVIRONMENT: 'other' as never }), ok, check)).toBe(
      BACKUP_ALERT_LOG.sent,
    );
    const payload = sentPayload();
    // An unknown environment label is left out, never echoed
    expect(payload.text).toBe('Bifrost backup WARNING');
    expect(payload.attachments[0].color).toBe('#f59e0b');
    expect(payload.attachments[0].blocks[1].fields).toHaveLength(4);
    expect(payload.attachments[0].blocks[2].text.text).toBe(
      '*Issues:*\n• 2 stored records are not JSON and were not backed up',
    );
  });

  it('alerts critical when the health check throws, logging the error class only', async () => {
    const check = vi.fn<HealthCheck>().mockRejectedValue(new TypeError('secret detail daily/x'));
    expect(await notifyBackupOutcome(withHook(), ok, check)).toBe(BACKUP_ALERT_LOG.sent);
    const payload = sentPayload();
    expect(payload.text).toBe('Bifrost backup CRITICAL (production)');
    expect(payload.attachments[0].blocks[2].text.text).toBe(
      `*Issues:*\n• ${HEALTH_CHECK_UNAVAILABLE}`,
    );
    expect(logs).toEqual([
      `${BACKUP_ALERT_LOG.healthCheckFailed}: TypeError`,
      BACKUP_ALERT_LOG.sent,
    ]);
    expect(logs.join('\n')).not.toContain('secret detail');
  });

  it('gives each delivery 10 seconds', () => {
    expect(ALERT_TIMEOUT_MS).toBe(10_000);
  });

  it('treats a health check that never settles as unavailable after 60 seconds', async () => {
    expect(HEALTH_CHECK_TIMEOUT_MS).toBe(60_000);
    vi.useFakeTimers();
    try {
      const check = vi.fn<HealthCheck>(() => new Promise<BackupHealthResponse>(() => {}));
      let settled = false;
      const outcome = notifyBackupOutcome(withHook(), ok, check).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe(BACKUP_ALERT_LOG.sent);
      const payload = sentPayload();
      expect(payload.text).toBe('Bifrost backup CRITICAL (production)');
      expect(payload.attachments[0].blocks[2].text.text).toContain(HEALTH_CHECK_UNAVAILABLE);
      expect(logs[0]).toBe(`${BACKUP_ALERT_LOG.healthCheckFailed}: HealthCheckTimeoutError`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the bound once the health check answers', async () => {
    vi.useFakeTimers();
    try {
      await notifyBackupOutcome(
        withHook(),
        ok,
        vi.fn<HealthCheck>().mockResolvedValue(health('healthy')),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a non-Error rejection from the health check by its type only', async () => {
    const check = vi.fn<HealthCheck>().mockRejectedValue('raw detail');
    await notifyBackupOutcome(withHook(), ok, check);
    expect(logs[0]).toBe(`${BACKUP_ALERT_LOG.healthCheckFailed}: string`);
    expect(logs.join('\n')).not.toContain('raw detail');
  });

  it('reports a rejected delivery with its HTTP status, never the URL', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('no_service', { status: 404 }));
    expect(await notifyBackupOutcome(withHook(), failed('x'), vi.fn<HealthCheck>())).toBe(
      `${BACKUP_ALERT_LOG.failed} (HTTP 404)`,
    );
    expect(logs).toEqual([`${BACKUP_ALERT_LOG.failed} (HTTP 404)`]);
    noUrlLogged();
  });

  it('treats a redirect as a failed delivery', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    );
    expect(await notifyBackupOutcome(withHook(), failed('x'), vi.fn<HealthCheck>())).toBe(
      `${BACKUP_ALERT_LOG.failed} (HTTP 302)`,
    );
    expect(logs.join('\n')).not.toContain('elsewhere.example');
  });

  it('never throws or logs the error when delivery fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`connect failed ${WEBHOOK}`));
    await expect(notifyBackupOutcome(withHook(), failed('x'), vi.fn<HealthCheck>())).resolves.toBe(
      BACKUP_ALERT_LOG.failed,
    );
    expect(logs).toEqual([BACKUP_ALERT_LOG.failed]);
    noUrlLogged();
  });
});
