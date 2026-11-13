// @vitest-environment happy-dom

/**
 * The Select value slot shows an ellipsis for a long value.
 *
 * `line-clamp-1` on the slot did nothing because the same slot was also
 * `display: flex`, which overrides the clamp's `display: -webkit-box`: a long
 * value clipped at the trigger border. happy-dom compiles no Tailwind, so this
 * pins the classes that produce the ellipsis and the slot structure they
 * target; the look itself was not checked in a real browser.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

const LONG = 'A very long selected value that is wider than the trigger it sits in';

async function renderSelect() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <Select value="long">
        <SelectTrigger className="w-40">
          <SelectValue>{LONG}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="long">{LONG}</SelectItem>
        </SelectContent>
      </Select>,
    );
  });
  const trigger = container.querySelector<HTMLElement>('[data-slot="select-trigger"]');
  expect(trigger).not.toBeNull();
  return trigger as HTMLElement;
}

describe('SelectTrigger value slot', () => {
  it('truncates the value with an ellipsis and lets it shrink', async () => {
    const classes = (await renderSelect()).className.split(/\s+/);
    expect(classes).toContain('*:data-[slot=select-value]:truncate');
    expect(classes).toContain('*:data-[slot=select-value]:min-w-0');
  });

  it('no longer makes the slot a flex container or relies on line-clamp', async () => {
    const classes = (await renderSelect()).className.split(/\s+/);
    const slotClasses = classes.filter(name => name.startsWith('*:data-[slot=select-value]:'));
    expect(slotClasses).not.toContain('*:data-[slot=select-value]:flex');
    expect(slotClasses.some(name => name.includes('line-clamp'))).toBe(false);
  });

  it('renders the value as a direct child of the trigger, where the slot classes apply', async () => {
    const trigger = await renderSelect();
    const value = [...trigger.children].find(
      child => child.getAttribute('data-slot') === 'select-value',
    );
    expect(value?.textContent).toBe(LONG);
  });
});
