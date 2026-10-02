// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsMobile } from './use-mobile';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let changeListener: (() => void) | undefined;
const renders: boolean[] = [];

function Probe() {
  renders.push(useIsMobile());
  return null;
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  renders.length = 0;
  changeListener = undefined;
  vi.stubGlobal(
    'matchMedia',
    vi.fn<(query: string) => MediaQueryList>(
      query =>
        ({
          media: query,
          matches: false,
          addEventListener: (_type: string, listener: () => void) => {
            changeListener = listener;
          },
          removeEventListener: () => {
            changeListener = undefined;
          },
        }) as unknown as MediaQueryList,
    ),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Probe />));
}

describe('useIsMobile', () => {
  it('reports a narrow viewport on the first render', async () => {
    setWidth(500);
    await mount();
    expect(renders[0]).toBe(true);
  });

  it('reports a wide viewport on the first render', async () => {
    setWidth(1280);
    await mount();
    expect(renders[0]).toBe(false);
  });

  it('follows the viewport across the breakpoint', async () => {
    setWidth(1280);
    await mount();
    setWidth(500);
    await act(async () => changeListener?.());
    expect(renders.at(-1)).toBe(true);
  });
});
