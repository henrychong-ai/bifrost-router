// @vitest-environment happy-dom

/**
 * useClearNavigationState (v1.37.1): consumed navigation state is cleared
 * through the router, keeping the path, query and hash, and never through
 * window.history behind the router's back.
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClearNavigationState } from './navigation-state';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
/** Router location keys, one per committed navigation. */
const keys: string[] = [];

/** Consumes `state.open` like a page would, and shows the router location. */
function Consumer() {
  const location = useLocation();
  useEffect(() => {
    keys.push(location.key);
  }, [location.key]);
  const consumed =
    typeof location.state === 'object' && location.state !== null && 'open' in location.state;
  useClearNavigationState(consumed);
  return <output data-testid="location">{JSON.stringify(location)}</output>;
}

function routerLocation(): { pathname: string; search: string; hash: string; state: unknown } {
  const text = document.querySelector('[data-testid="location"]')?.textContent;
  if (!text) throw new Error('no location rendered');
  return JSON.parse(text) as { pathname: string; search: string; hash: string; state: unknown };
}

async function render(entry: {
  pathname: string;
  search?: string;
  hash?: string;
  state?: unknown;
}) {
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <Consumer />
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  keys.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('useClearNavigationState', () => {
  it('clears consumed state through the router, keeping path, query and hash', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    await render({
      pathname: '/qr-codes',
      search: '?from=routes',
      hash: '#top',
      state: { open: 1 },
    });

    expect(routerLocation()).toMatchObject({
      pathname: '/qr-codes',
      search: '?from=routes',
      hash: '#top',
      state: null,
    });
    // The router's own state, not the browser history behind its back
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('settles after one clear: no navigation loop', async () => {
    await render({ pathname: '/', state: { open: 1 } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(routerLocation().state).toBeNull();
    // The initial entry, then exactly one replace
    expect(keys).toHaveLength(2);
  });

  it('leaves state the page did not consume alone', async () => {
    await render({ pathname: '/', state: { other: 1 } });
    expect(routerLocation().state).toEqual({ other: 1 });
  });

  // Under a real browser-history router the history entry itself must change:
  // state cleared in place, with path, query and hash kept, by one replace.
  it('clears the browser history entry under BrowserRouter with one replace', async () => {
    window.history.replaceState(
      { usr: { open: 1 }, key: 'handoff', idx: 0 },
      '',
      '/qr-codes?from=routes#top',
    );
    const length = window.history.length;
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    try {
      await act(async () =>
        root?.render(
          <BrowserRouter>
            <Consumer />
          </BrowserRouter>,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(replaceState).toHaveBeenCalledOnce();
      expect(pushState).not.toHaveBeenCalled();
      expect(window.history.length).toBe(length);
      expect((window.history.state as { usr?: unknown } | null)?.usr).toBeNull();
      expect(window.location.pathname).toBe('/qr-codes');
      expect(window.location.search).toBe('?from=routes');
      expect(window.location.hash).toBe('#top');
      expect(routerLocation().state).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});
