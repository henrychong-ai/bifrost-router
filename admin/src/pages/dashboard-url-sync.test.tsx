// @vitest-environment happy-dom

/**
 * The dashboard's search and country inputs follow the URL when it changes
 * underneath them (back/forward, a deep link), and the debounce that writes
 * typed text back to the URL never pushes the old text over the new URL.
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, type NavigateFunction, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './dashboard';
import { summary } from './dashboard-summary.fixture';

vi.mock('@/hooks', () => ({
  useAnalyticsSummary: () => ({
    data: summary,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn<() => void>(),
  }),
}));
vi.mock('@/components/backup-health-widget', () => ({ BackupHealthWidget: () => null }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
/** The router as the test drives and reads it, captured after each commit. */
const router: { navigate?: NavigateFunction; search: string } = { search: '' };

function RouterProbe() {
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => {
    router.navigate = navigate;
    router.search = search;
  });
  return null;
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/?search=alpha&country=SG']}>
        <RouterProbe />
        <DashboardPage />
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
});

describe('dashboard filter inputs and the URL', () => {
  it('start from the URL', () => {
    expect(input('dashboard-search').value).toBe('alpha');
    expect(input('dashboard-country').value).toBe('SG');
  });

  it('follow a URL change and leave the new URL in place', async () => {
    await act(async () => router.navigate?.('/?search=beta&country=MY'));

    expect(input('dashboard-search').value).toBe('beta');
    expect(input('dashboard-country').value).toBe('MY');

    // Past the 300 ms debounce, the URL still carries the new values.
    await act(async () => vi.advanceTimersByTime(1000));
    const params = new URLSearchParams(router.search);
    expect(params.get('search')).toBe('beta');
    expect(params.get('country')).toBe('MY');
  });
});
