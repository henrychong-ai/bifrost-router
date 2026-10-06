/**
 * The backup health answer is read as unknown and validated (v1.38.0): the
 * widget never renders a body of another shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupApi } from './api-client';

vi.mock('@/env', () => ({
  env: { VITE_API_URL: 'https://api.example.test', ADMIN_API_KEY: 'test-admin-key' },
}));

const healthy = {
  status: 'healthy',
  timestamp: '2026-10-06T00:00:00Z',
  lastBackup: null,
  issues: [],
  checks: {
    backupExists: false,
    backupAge: 'ok',
    manifestValid: false,
    filesComplete: false,
    routeCountOk: true,
  },
};

const answer = (body: unknown) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe('backupApi.health', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a valid answer', async () => {
    answer(healthy);
    await expect(backupApi.health()).resolves.toEqual(healthy);
  });

  it.each([
    ['null', null],
    ['an unknown status', { ...healthy, status: 'fine' }],
    ['issues that are not a list', { ...healthy, issues: 'none' }],
  ])('refuses an answer that is %s', async (_label, body) => {
    answer(body);
    await expect(backupApi.health()).rejects.toBeInstanceOf(Error);
  });
});
