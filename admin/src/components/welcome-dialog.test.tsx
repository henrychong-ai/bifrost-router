// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WELCOME_SEEN_STORAGE_KEY } from '@/lib/constants';
import { WelcomeDialog } from './welcome-dialog';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <WelcomeDialog />
      </MemoryRouter>,
    );
  });
}

function shown(): boolean {
  return document.body.textContent?.includes('Welcome to Bifrost') ?? false;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('WelcomeDialog', () => {
  it('opens on a first visit', async () => {
    await mount();
    expect(shown()).toBe(true);
  });

  it('stays closed once seen', async () => {
    localStorage.setItem(WELCOME_SEEN_STORAGE_KEY, '1');
    await mount();
    expect(shown()).toBe(false);
  });

  it('records the visit when dismissed', async () => {
    await mount();
    const dismiss = [...document.body.querySelectorAll('button')].find(
      button => button.textContent === 'Explore on my own',
    );
    await act(async () => dismiss?.click());
    expect(localStorage.getItem(WELCOME_SEEN_STORAGE_KEY)).not.toBeNull();
    expect(shown()).toBe(false);
  });
});
