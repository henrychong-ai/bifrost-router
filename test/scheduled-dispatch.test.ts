import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Bindings } from '../src/types';

/**
 * The Worker's scheduled() entry point: the daily backup cron runs the KV
 * backup inside waitUntil and logs its outcome, success or failure.
 */
async function runCron(cron: string, bindings: Bindings): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron, scheduledTime: Date.now(), type: 'scheduled' } as unknown as ScheduledEvent,
    bindings,
    {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
}

describe('scheduled backup cron', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a completed backup with its route count', async () => {
    await env.ROUTES.put(
      'links.example.com:/scheduled-dispatch',
      JSON.stringify({
        path: '/scheduled-dispatch',
        type: 'redirect',
        target: 'https://example.com',
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCron('0 20 * * *', env as unknown as Bindings);

    const lines = log.mock.calls.map(args => String(args[0]));
    expect(
      lines.some(line => /^\[Scheduled\] Backup completed in \d+ms - \d+ routes$/.test(line)),
    ).toBe(true);
  });

  it('logs a failed backup with its error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCron('0 20 * * *', { ...env, BACKUP_BUCKET: undefined } as unknown as Bindings);

    expect(error.mock.calls.map(args => String(args[0]))).toContain(
      '[Scheduled] Backup failed: BACKUP_BUCKET not configured',
    );
  });
});
