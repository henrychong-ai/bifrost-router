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

  // v1.37.1: every log line carries fixed text only; a stored value that is
  // not JSON used to reach them through the parse error. v1.38.0: such a value
  // is skipped and counted, logged by its key only, and the backup succeeds
  // (it used to fail every nightly run until someone deleted the record).
  it('keeps a malformed stored value out of every log line, and backs up past it', async () => {
    // Short and bare: V8's parse error quotes the first ten characters
    const secret = 'zq7f3a91x';
    await env.ROUTES.put('links.example.com:/malformed', secret);
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const [backup] = await runCron('0 20 * * *', env as unknown as Bindings);
      expect(backup.status).toBe('fulfilled');
      const logged = spies.flatMap(spy =>
        spy.mock.calls
          .flat()
          .map(arg =>
            arg instanceof Error
              ? `${arg.message} ${arg.stack ?? ''} ${String(arg.cause)}`
              : String(arg),
          ),
      );
      // Named by its key, never its value
      expect(logged).toContain(
        '[Backup] Skipped a KV record that is not JSON: links.example.com:/malformed',
      );
      // v1.40.0: the completed run says at error level that it skipped records
      expect(spies[2]?.mock.calls.map(args => String(args[0]))).toContain(
        '[Scheduled] Backup skipped 1 record(s): 1 not JSON, 0 over the record line limit',
      );
      expect(logged.join('\n')).not.toContain(secret);
    } finally {
      await env.ROUTES.delete('links.example.com:/malformed');
    }
  });

  it('rejects a platform error with the generic text and logs its class once', async () => {
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
    // The platform error is logged once, by its class only (v1.39.0): a
    // message can quote a key or a stored value
    expect(errorLog.mock.calls).toEqual([
      ['[Backup] Platform error: Error'],
      ['[Scheduled] Backup failed: Storage or platform error'],
    ]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('internal detail');
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
      ['[Backup] Platform error: SyntaxError'],
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
