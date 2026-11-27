import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv, Bindings, KVRouteConfig } from '../../src/types';
import {
  clearAllRoutes,
  createAuditLogsTable,
  createSettlingExecutionContext,
  seedRoute,
} from '../helpers';

/**
 * The seed audit row records what the seed changed (v1.47.0): the routes it
 * created, by stored path, with `created` and `skipped` counts. Before, it
 * recorded every valid entry sent (`count`, `paths`), so a seed of 50 entries
 * of which 48 already existed read as 50 routes seeded, and a write failing
 * part-way left the routes already written with no row at all. A seed that
 * creates nothing still records the attempt (`created: 0`); a refused seed
 * records nothing, as before.
 *
 * The credential acknowledgement covers the entries the seed will write only
 * (v1.47.0): before, an entry it would skip (an existing route, a losing
 * duplicate) refused the whole seed unless acknowledged, so a seed file could
 * not be re-run. One admin key, so there is no per-route permission refusal.
 * Driven through the real admin router with a settleable ExecutionContext, so
 * the non-blocking audit write completes first.
 */

const API_KEY = 'test-api-key-12345'; // gitleaks:allow
const DOMAIN = 'links.example.com';

async function post(path: string, body: unknown): Promise<Response> {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await new Hono<AppEnv>().route('/api', adminRoutes).fetch(
    new Request(`http://bifrost.example.com/api${path}?domain=${DOMAIN}`, {
      method: 'POST',
      headers: { 'X-Admin-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { ...env, ADMIN_API_DOMAIN: 'bifrost.example.com' },
    ctx,
  );
  await settled();
  return response;
}

const seed = (routes: unknown[], extra: Record<string, unknown> = {}) =>
  post('/routes/seed', { routes, ...extra });

/** Make the route store's `put` fail from its `n`th call on, as a KV outage would. */
function failPutsFrom(n: number): void {
  const realPut = env.ROUTES.put.bind(env.ROUTES);
  let puts = 0;
  vi.spyOn(env.ROUTES, 'put').mockImplementation((async (...args: unknown[]) => {
    puts += 1;
    if (puts >= n) throw new Error('simulated KV outage');
    return (realPut as (...a: unknown[]) => Promise<void>)(...args);
  }) as typeof env.ROUTES.put);
}

const stored = (path: string) => env.ROUTES.get(`${DOMAIN}:${path}`);

const plainRecord = (path: string, target = 'https://example.com/old'): KVRouteConfig => ({
  path,
  type: 'redirect',
  target,
  createdAt: 1,
  updatedAt: 1,
});

/** Every seed audit row, oldest first, with its details parsed. */
async function seedRows(): Promise<{ path: string | null; details: unknown }[]> {
  const { results } = await env.DB.prepare(
    "SELECT path, details FROM audit_logs WHERE action = 'seed' ORDER BY id",
  ).all<{ path: string | null; details: string }>();
  return results.map(row => ({ path: row.path, details: JSON.parse(row.details) as unknown }));
}

const redirect = (path: string, target = `https://example.com${path}`) => ({
  path,
  type: 'redirect',
  target,
});

beforeEach(async () => {
  await createAuditLogsTable();
  await clearAllRoutes();
  await env.DB.prepare('DELETE FROM audit_logs').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('seed audit row', () => {
  it('records only the routes the seed created, with created and skipped counts', async () => {
    await seedRoute(plainRecord('/kept'), DOMAIN);

    const response = await seed([
      redirect('/New-One'),
      // A duplicate of the first by normalised key: loses, skipped
      redirect('/new-one', 'https://example.com/loser'),
      // Exists already: skipped, never overwritten
      redirect('/kept'),
      redirect('/two'),
    ]);

    expect(response.status).toBe(200);
    // The answer keeps its shape: the counts and the input paths written
    expect(await response.json()).toEqual({
      success: true,
      data: { created: 2, skipped: 2, createdPaths: ['/New-One', '/two'] },
    });
    // The row lists the stored (normalised) paths written, nothing else
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 2, skipped: 2, paths: ['/new-one', '/two'] } },
    ]);
    expect(JSON.parse((await stored('/kept')) ?? '{}')).toMatchObject({
      target: 'https://example.com/old',
    });
    expect(JSON.parse((await stored('/new-one')) ?? '{}')).toMatchObject({
      target: 'https://example.com/New-One',
    });
  });

  it('a seed that creates nothing still records the attempt, with created: 0', async () => {
    await seedRoute(plainRecord('/a'), DOMAIN);
    await seedRoute(plainRecord('/b'), DOMAIN);

    const response = await seed([redirect('/a'), redirect('/B'), redirect('/b')]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { created: 0, skipped: 3, createdPaths: [] },
    });
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 0, skipped: 3, paths: [] } },
    ]);
  });

  it('an empty seed records created: 0 and skipped: 0', async () => {
    const response = await seed([]);

    expect(response.status).toBe(200);
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 0, skipped: 0, paths: [] } },
    ]);
  });

  it('a batch refused for an entry shape writes no route and no audit row', async () => {
    const response = await seed([redirect('/fine'), redirect('no-leading-slash')]);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Some routes failed validation',
    );
    expect(await stored('/fine')).toBeNull();
    expect(await seedRows()).toEqual([]);
  });

  it('a batch refused for a record over the size limit writes no route and no audit row', async () => {
    const response = await seed([
      redirect('/fine'),
      { ...redirect('/big'), hostHeader: 'h'.repeat(70 * 1024) },
    ]);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await stored('/fine')).toBeNull();
    expect(await seedRows()).toEqual([]);
  });

  it('a KV write that fails on the Nth route records the N-1 written, marked failed, and answers as a create does', async () => {
    // The answer a single create gets from the same failure: seed answers alike
    failPutsFrom(1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createAnswer = await post('/routes', redirect('/single'));
    vi.restoreAllMocks();

    failPutsFrom(3);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await seed([
      redirect('/w1'),
      redirect('/w2'),
      redirect('/w3'),
      redirect('/w4'),
    ]);

    expect(response.status).toBe(createAnswer.status);
    expect(response.status).toBeGreaterThanOrEqual(500);
    // The original KV error is rethrown, never the seed's wrapper, so the
    // answer is the one a create gets for the same failure
    const body = await response.text();
    expect(body).toBe(await createAnswer.text());
    expect(body).not.toContain('/w');
    expect(errors).toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await stored('/w2')).not.toBeNull();
    expect(await stored('/w3')).toBeNull();
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 2, skipped: 0, paths: ['/w1', '/w2'], failed: true } },
    ]);
  });

  it('through the Worker, a part-way failure is logged and answered as the KV error, never the wrapper', async () => {
    failPutsFrom(2);
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const { ctx, settled } = createSettlingExecutionContext();
    const response = await worker.fetch(
      new Request(`https://bifrost.example.com/api/routes/seed?domain=${DOMAIN}`, {
        method: 'POST',
        headers: { 'X-Admin-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ routes: [redirect('/w1'), redirect('/w2')] }),
      }),
      { ...env, ADMIN_API_DOMAIN: 'bifrost.example.com' } as Bindings,
      ctx,
    );
    await settled();

    expect(response.status).toBe(500);
    const unhandled = lines
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => entry['message'] === 'Unhandled error');
    expect(unhandled.map(entry => entry['errorName'])).toEqual(['KVWriteError']);
    vi.restoreAllMocks();
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 1, skipped: 0, paths: ['/w1'], failed: true } },
    ]);
  });

  it('a KV write that fails on the first route still records the attempt, created: 0 and failed', async () => {
    await seedRoute(plainRecord('/old'), DOMAIN);
    failPutsFrom(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await seed([redirect('/old'), redirect('/w1')]);

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 0, skipped: 1, paths: [], failed: true } },
    ]);
  });

  it('credentialTargetAcknowledged names the credential parameters of the routes written only', async () => {
    // Exists already: its entry is skipped, so its `password` is not recorded
    await seedRoute(plainRecord('/old'), DOMAIN);
    const response = await seed(
      [
        redirect('/old', 'https://idp.example/in?password=SKIPPED-VALUE'),
        redirect('/new', 'https://idp.example/in?token=WRITTEN-VALUE'),
        // Loses to /new: its `secret` is never written
        redirect('/NEW', 'https://idp.example/in?secret=LOSER-VALUE'),
      ],
      { acknowledgeCredentialTarget: true },
    );

    expect(response.status).toBe(200);
    const rows = await seedRows();
    expect(rows).toEqual([
      {
        path: null,
        details: {
          created: 1,
          skipped: 2,
          paths: ['/new'],
          credentialTargetAcknowledged: ['token'],
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('VALUE');
  });

  it('an acknowledged batch whose credential-shaped entries are all skipped records no acknowledgement', async () => {
    await seedRoute(plainRecord('/old'), DOMAIN);
    const response = await seed(
      [redirect('/old', 'https://idp.example/in?token=SKIPPED'), redirect('/plain')],
      { acknowledgeCredentialTarget: true },
    );

    expect(response.status).toBe(200);
    expect(await seedRows()).toEqual([
      { path: null, details: { created: 1, skipped: 1, paths: ['/plain'] } },
    ]);
  });
});

/** The seed's credential-target refusal naming `parameters` on `paths`. */
const refusal = (parameters: string[], paths: string[]) => ({
  success: false,
  error: 'ROUTE_TARGET_CREDENTIAL',
  message: `A seeded route target carries credential-named parameter${parameters.length === 1 ? '' : 's'} (${parameters.join(', ')}); anyone with the short link can use ${parameters.length === 1 ? 'it' : 'them'}. Re-send with acknowledgeCredentialTarget: true to store it anyway.`,
  details: { parameters, paths },
});

describe('seed credential acknowledgement covers the entries the seed writes', () => {
  const TOKEN_TARGET = 'https://idp.example/in?token=LIVE-VALUE';

  it('re-running a seed whose credential-shaped entry already exists needs no acknowledgement and writes nothing for it', async () => {
    await seedRoute(plainRecord('/login'), DOMAIN);

    const response = await seed([redirect('/login', TOKEN_TARGET), redirect('/plain')]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { created: 1, skipped: 1, createdPaths: ['/plain'] },
    });
    // The existing route is untouched: the credential-shaped target was never written
    expect(JSON.parse((await stored('/login')) ?? '{}')).toMatchObject({
      target: 'https://example.com/old',
    });
    const rows = await seedRows();
    expect(rows).toEqual([{ path: null, details: { created: 1, skipped: 1, paths: ['/plain'] } }]);
    expect(JSON.stringify(rows)).not.toContain('LIVE-VALUE');
  });

  it('a losing duplicate with a credential-shaped target needs no acknowledgement', async () => {
    const response = await seed([redirect('/dup'), redirect('/DUP', TOKEN_TARGET)]);

    expect(response.status).toBe(200);
    expect(JSON.parse((await stored('/dup')) ?? '{}')).toMatchObject({
      target: 'https://example.com/dup',
    });
    const rows = await seedRows();
    expect(rows).toEqual([{ path: null, details: { created: 1, skipped: 1, paths: ['/dup'] } }]);
    expect(JSON.stringify(rows)).not.toContain('LIVE-VALUE');
  });

  it('a new credential-shaped entry is still refused without the acknowledgement, with the same answer, and nothing is written', async () => {
    const response = await seed([redirect('/plain'), redirect('/new', TOKEN_TARGET)]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual(refusal(['token'], ['/new']));
    expect(JSON.stringify(body)).not.toContain('LIVE-VALUE');
    expect(await stored('/plain')).toBeNull();
    expect(await stored('/new')).toBeNull();
    expect(await seedRows()).toEqual([]);
  });

  it('a mixed file names only the entries it would write, and is written once acknowledged', async () => {
    await seedRoute(plainRecord('/old'), DOMAIN);
    const routes = [
      // Exists: skipped, its `password` is not part of the decision
      redirect('/old', 'https://idp.example/in?password=SKIPPED'),
      redirect('/new', TOKEN_TARGET),
      // Loses to /new: its `secret` is not part of the decision
      redirect('/NEW', 'https://idp.example/in?secret=LOSER'),
      redirect('/also', 'https://idp.example/in?api_key=ALSO'),
      redirect('/plain'),
    ];

    const refused = await seed(routes);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(refusal(['token', 'api_key'], ['/new', '/also']));
    expect(await stored('/plain')).toBeNull();
    expect(await seedRows()).toEqual([]);

    const accepted = await seed(routes, { acknowledgeCredentialTarget: true });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      success: true,
      data: { created: 3, skipped: 2, createdPaths: ['/new', '/also', '/plain'] },
    });
    expect(await seedRows()).toEqual([
      {
        path: null,
        details: {
          created: 3,
          skipped: 2,
          paths: ['/new', '/also', '/plain'],
          credentialTargetAcknowledged: ['token', 'api_key'],
        },
      },
    ]);
  });
});
