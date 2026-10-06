import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';

/**
 * The Worker's scheduled() entry point: the daily backup cron runs the KV
 * backup inside waitUntil and logs its outcome, success or failure; a failure
 * also rejects the backup's waitUntil promise (v1.37.1).
 *
 * Returns how each waitUntil promise settled, in registration order.
 */
async function runCron(cron: string, bindings: Bindings): Promise<PromiseSettledResult<unknown>[]> {
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
  return Promise.allSettled(pending);
}

/** A D1 stand-in that records whether the unified-traffic prune ran. */
function pruneDb(): { db: D1Database; pruned: () => boolean } {
  let pruned = false;
  const db = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          pruned = true;
          return { meta: { changes: 0 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, pruned: () => pruned };
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

    const settled = await runCron('0 20 * * *', env as unknown as Bindings);

    const lines = log.mock.calls.map(args => String(args[0]));
    expect(
      lines.some(line => /^\[Scheduled\] Backup completed in \d+ms - \d+ routes$/.test(line)),
    ).toBe(true);
    expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
  });

  it('logs a failed backup with its error, then rejects its waitUntil (v1.37.1)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const settled = await runCron('0 20 * * *', {
      ...env,
      BACKUP_BUCKET: undefined,
    } as unknown as Bindings);

    // One log line per failure, fixed text
    expect(error.mock.calls.map(args => String(args[0]))).toEqual([
      '[Scheduled] Backup failed: BACKUP_BUCKET not configured',
    ]);
    // The rejection is the invocation outcome the runtime records
    expect(settled).toHaveLength(1);
    const [backup] = settled;
    expect(backup.status).toBe('rejected');
    expect((backup as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(((backup as PromiseRejectedResult).reason as Error).message).toBe(
      'Backup failed: BACKUP_BUCKET not configured',
    );
  });

  // v1.37.1: the rejection and every log line carry fixed text only. A stored
  // value that is not JSON used to reach both through the parse error.
  it('keeps a malformed stored value out of the rejection and every log line', async () => {
    // Short and bare: V8's parse error quotes the first ten characters
    const secret = 'zq7f3a91x';
    await env.ROUTES.put('links.example.com:/malformed', secret);
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const [backup] = await runCron('0 20 * * *', env as unknown as Bindings);
      expect(backup.status).toBe('rejected');
      const reason = (backup as PromiseRejectedResult).reason as Error;
      expect(reason.message).toBe('Backup failed: KV record is not valid JSON');
      expect(reason.cause).toBeUndefined();
      const logged = spies.flatMap(spy =>
        spy.mock.calls
          .flat()
          .map(arg =>
            arg instanceof Error
              ? `${arg.message} ${arg.stack ?? ''} ${String(arg.cause)}`
              : String(arg),
          ),
      );
      expect(logged).toContain('[Scheduled] Backup failed: KV record is not valid JSON');
      // The malformed record is located by prefix and listing index, not key
      expect(logged).toContain(
        '[Backup] KV record is not valid JSON: prefix links.example.com:, listing index 0',
      );
      expect(logged.join('\n')).not.toContain('/malformed');
      expect(logged.join('\n')).not.toContain(secret);
      expect(`${reason.message} ${reason.stack ?? ''}`).not.toContain(secret);
    } finally {
      await env.ROUTES.delete('links.example.com:/malformed');
    }
  });

  it('rejects a platform error with the generic text and logs the error itself once', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingKv = {
      list: async () => {
        throw new Error('KV list unavailable: internal detail');
      },
    } as unknown as KVNamespace;

    const [backup] = await runCron('0 20 * * *', {
      ...env,
      ROUTES: failingKv,
    } as unknown as Bindings);

    expect(((backup as PromiseRejectedResult).reason as Error).message).toBe(
      'Backup failed: Storage or platform error',
    );
    const lines = errorLog.mock.calls.map(args => String(args[0]));
    expect(lines).toEqual([
      '[Backup] Platform error:',
      '[Scheduled] Backup failed: Storage or platform error',
    ]);
    // The platform error is logged once, as it is, for diagnosis
    expect(errorLog.mock.calls[0]?.[1]).toMatchObject({
      message: 'KV list unavailable: internal detail',
    });
  });

  // A SyntaxError's message can quote the text it failed to parse, so a
  // non-fixed one is logged by name only.
  it('logs a stray SyntaxError by name only, never its message', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingKv = {
      list: async () => {
        throw new SyntaxError('Unexpected token, "zq7f3a91x" is not valid JSON');
      },
    } as unknown as KVNamespace;

    const [backup] = await runCron('0 20 * * *', {
      ...env,
      ROUTES: failingKv,
    } as unknown as Bindings);

    expect(((backup as PromiseRejectedResult).reason as Error).message).toBe(
      'Backup failed: Storage or platform error',
    );
    expect(errorLog.mock.calls).toEqual([
      ['[Backup] Platform error:', 'SyntaxError'],
      ['[Scheduled] Backup failed: Storage or platform error'],
    ]);
  });

  it('keeps the unified-traffic prune tracked and running when the backup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, pruned } = pruneDb();

    const settled = await runCron('0 20 * * *', {
      ...env,
      BACKUP_BUCKET: undefined,
      DB: db,
      UNIFIED_TRAFFIC_CUTOVER_AT: '2026-01-01T00:00:00Z',
      UNIFIED_TRAFFIC_RETENTION_DAYS: '30',
    } as unknown as Bindings);

    // Two promises: the backup's rejection does not stand in for the prune's
    expect(settled.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(pruned()).toBe(true);
  });

  it('registers no prune before the unified-traffic cutover', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db, pruned } = pruneDb();

    const settled = await runCron('0 20 * * *', {
      ...env,
      DB: db,
      UNIFIED_TRAFFIC_CUTOVER_AT: '2999-01-01T00:00:00Z',
      UNIFIED_TRAFFIC_RETENTION_DAYS: '30',
    } as unknown as Bindings);

    expect(settled).toHaveLength(1);
    expect(pruned()).toBe(false);
  });
});
