// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilterToolbar } from './filter-toolbar';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <FilterToolbar
        filters={{}}
        onFiltersChange={() => undefined}
        searchLabel="Path"
        search2Label="Target"
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('FilterToolbar labels', () => {
  it('labels every control it renders', () => {
    const labels = [...document.body.querySelectorAll('label')];
    expect(labels.map(label => label.textContent)).toEqual([
      'Path',
      'Target',
      'Domain',
      'Country',
      'Time Range',
    ]);
    for (const label of labels) {
      const control = document.getElementById(label.htmlFor);
      // A text input, or the Select's trigger button.
      expect([label.textContent, control?.tagName]).toEqual([
        label.textContent,
        expect.stringMatching(/^(INPUT|BUTTON)$/),
      ]);
    }
  });
});
