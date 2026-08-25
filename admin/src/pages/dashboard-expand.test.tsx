// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './dashboard';
import { summary } from './dashboard-summary.fixture';

/**
 * The expand control's CLIENT behaviour.
 *
 * The static-markup suite can only see the initial paint, so it proves the
 * control renders — not that clicking it does anything. This mounts the real
 * component, clicks the button, and asserts both halves of the effect: the card
 * claims the full grid AND the Destination cell's width cap is lifted. The cap
 * is the half that was missed first time round: widening the card while leaving
 * `max-w-80` on the cell means long destination URLs stay truncated, so the
 * control appears to do nothing for the case it exists to serve.
 */
const mockUseAnalyticsSummary = vi.hoisted(() => vi.fn());
vi.mock('@/hooks', () => ({ useAnalyticsSummary: mockUseAnalyticsSummary }));
vi.mock('@/components/backup-health-widget', () => ({ BackupHealthWidget: () => null }));

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

/** The Card element wrapping a named leaderboard control. */
function cardFor(container: HTMLElement, label: string): HTMLElement {
  const button = container.querySelector(`[aria-label$="${label}"]`);
  expect(button, `control for ${label}`).not.toBeNull();
  const card = button?.closest('[data-slot="card"]');
  expect(card, `card for ${label}`).not.toBeNull();
  return card as HTMLElement;
}

describe('leaderboard expand control (client render)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockUseAnalyticsSummary.mockReturnValue({
      data: summary,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('widens the card AND lifts the destination width cap when clicked', () => {
    const { container, root } = mount();

    const collapsed = cardFor(container, 'Top Routes - Redirect');
    expect(collapsed.className).not.toContain('xl:col-span-2');
    expect(collapsed.querySelector('td.max-w-80')).not.toBeNull();

    const toggle = container.querySelector(
      '[aria-label="Expand Top Routes - Redirect"]',
    ) as HTMLButtonElement;
    act(() => toggle.click());

    const expanded = cardFor(container, 'Top Routes - Redirect');
    expect(expanded.className).toContain('xl:col-span-2');
    // The cap is gone, so a long destination URL can actually use the width.
    expect(expanded.querySelector('td.max-w-80')).toBeNull();
    expect(expanded.querySelector('td.max-w-none')).not.toBeNull();
    // ...and the control now offers the inverse action.
    expect(container.querySelector('[aria-label="Minimise Top Routes - Redirect"]')).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Minimise Top Routes - Redirect"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    act(() => root.unmount());
  });

  it('collapses again on a second click', () => {
    const { container, root } = mount();

    const toggle = () =>
      container.querySelector('[aria-label$="Top Routes - Redirect"]') as HTMLButtonElement;
    act(() => toggle().click());
    act(() => toggle().click());

    const card = cardFor(container, 'Top Routes - Redirect');
    expect(card.className).not.toContain('xl:col-span-2');
    expect(card.querySelector('td.max-w-80')).not.toBeNull();

    act(() => root.unmount());
  });

  it('expands only one card at a time', () => {
    // Two full-width cards would just be the collapsed layout with more
    // scrolling, so opening one closes the other.
    const { container, root } = mount();

    act(() => {
      (
        container.querySelector('[aria-label="Expand Top Routes - Redirect"]') as HTMLButtonElement
      ).click();
    });
    act(() => {
      (
        container.querySelector('[aria-label="Expand Top Routes - Proxy"]') as HTMLButtonElement
      ).click();
    });

    expect(cardFor(container, 'Top Routes - Redirect').className).not.toContain('xl:col-span-2');
    expect(cardFor(container, 'Top Routes - Proxy').className).toContain('xl:col-span-2');

    act(() => root.unmount());
  });
});
