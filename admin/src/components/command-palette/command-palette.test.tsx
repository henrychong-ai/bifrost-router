// @vitest-environment happy-dom

/**
 * Cmd+K (v1.38.0): commands match with the shared matcher (case, separators
 * and word order ignored), route search waits for two trimmed characters and
 * shows the server's relevance order.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '@/lib/schemas';

const searches = vi.hoisted(() => vi.fn<(query: string) => void>());
const results = vi.hoisted(() => ({ routes: [] as Route[] }));

vi.mock('@/hooks', () => ({
  MIN_ROUTE_SEARCH_LENGTH: 2,
  useDebounce: <T,>(value: T) => value,
  useSearchRoutes: (query: string) => {
    searches(query);
    return {
      data: query.trim().length >= 2 ? { routes: results.routes } : undefined,
      isLoading: false,
    };
  },
}));
vi.mock('@/hooks/use-command-palette', () => ({
  useCommandPalette: () => ({
    isOpen: true,
    close: vi.fn<() => void>(),
    toggle: vi.fn<() => void>(),
    open: vi.fn<() => void>(),
  }),
}));
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcut: () => undefined,
  getModifierKey: () => 'Ctrl',
}));
vi.mock('@/context', () => ({ useRoutesFilters: () => ({ setFilters: vi.fn<() => void>() }) }));

import { CommandPalette } from './command-palette';

const route = (path: string): Route => ({
  path,
  type: 'redirect',
  target: 'https://example.net/',
  createdAt: 1,
  updatedAt: 1,
  domain: 'example.com',
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  results.routes = [];
  searches.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function type(value: string) {
  const field = document.body.querySelector<HTMLInputElement>('[cmdk-input]');
  if (!field) throw new Error('no palette input');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const items = () =>
  [...document.body.querySelectorAll('[cmdk-item]')].map(item => item.textContent ?? '');

describe('command palette search', () => {
  it.each(['create route', 'Route_Create', 'new route create'])(
    'finds Create New Route for %j',
    async query => {
      await type(query);
      expect(items().some(text => text.includes('Create New Route'))).toBe(true);
    },
  );

  it('waits for two trimmed characters before searching routes', async () => {
    results.routes = [route('/summer-sale')];
    await type(' s ');
    expect(searches).toHaveBeenLastCalledWith('s');
    expect(items().some(text => text.includes('/summer-sale'))).toBe(false);
    await type(' su ');
    expect(searches).toHaveBeenLastCalledWith('su');
    expect(items().some(text => text.includes('/summer-sale'))).toBe(true);
  });

  it('shows the first 15 routes in the server order', async () => {
    results.routes = Array.from({ length: 20 }, (_, i) => route(`/r-${i}`));
    await type('r-');
    const shown = items().filter(text => text.includes('/r-'));
    expect(shown.slice(0, 3).map(text => text.match(/\/r-\d+/)?.[0])).toEqual([
      '/r-0',
      '/r-1',
      '/r-2',
    ]);
    expect(items().some(text => text.includes('View all 20 results'))).toBe(true);
  });
});
