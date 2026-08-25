import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './dashboard';
import { summary } from './dashboard-summary.fixture';

const mockUseAnalyticsSummary = vi.hoisted(() => vi.fn());

vi.mock('@/hooks', () => ({ useAnalyticsSummary: mockUseAnalyticsSummary }));
vi.mock('@/components/backup-health-widget', () => ({ BackupHealthWidget: () => null }));

describe('DashboardPage', () => {
  beforeEach(() => {
    mockUseAnalyticsSummary.mockReturnValue({
      data: summary,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('renders canonical full URLs, explicit route labels, and monitoring control', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(html).toContain('Top Routes - Redirect');
    expect(html).toContain('Top Routes - Proxy');
    expect(html).toContain('Top Website Pages');
    expect(html).toContain('Top Domains');
    expect(html).toContain('Top Countries');
    expect(html).toContain('Top Referrers');
    expect(html).toContain('Include Cloudflare Health Checks');
    expect(html).toContain('https://example.com/welcome');
    expect(html).toContain('https://example.com/api-status');
    expect(html).toContain('https://example.com/about');
  });

  it('offers an expand control on each leaderboard card, collapsed by default', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Collapsed: the control offers to Expand and reports aria-pressed=false.
    // aria-pressed rather than aria-expanded — it widens the card, it does not
    // disclose hidden content.
    expect(html).toContain('aria-label="Expand Top Routes - Redirect"');
    expect(html).toContain('aria-label="Expand Top Routes - Proxy"');
    expect(html).toContain('aria-pressed="false"');
    // ...and specifically NOT aria-expanded on the control itself. (Radix
    // primitives elsewhere on the page legitimately use aria-expanded, so scope
    // the check to the expand button's own markup.)
    const control = html.slice(html.indexOf('aria-label="Expand Top Routes - Redirect"'));
    const controlTag = control.slice(0, control.indexOf('>'));
    expect(controlTag).toContain('aria-pressed');
    expect(controlTag).not.toContain('aria-expanded');
    // The control must point at the content it expands, or a screen reader
    // cannot associate the two.
    expect(html).toContain('aria-controls="top-routes-redirect"');
    expect(html).toContain('id="top-routes-redirect"');
    expect(html).toContain('aria-controls="top-routes-proxy"');
    expect(html).toContain('id="top-routes-proxy"');
    // Nothing is pre-expanded, so neither leader CARD claims the full grid on
    // first paint. (The filter bar uses xl:col-span-2 unconditionally, so count
    // the card-level occurrences rather than asserting the class is absent.)
    const expandedCards = html.match(/data-slot="card" class="[^"]*xl:col-span-2/g);
    expect(expandedCards).toBeNull();
  });

  it('links each Recent Activity row to its filtered analytics view', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/?days=7&includeMonitoring=true']}>
        <DashboardPage />
      </MemoryRouter>,
    );

    // The event's own domain, path, and country travel with the link — landing
    // on an unfiltered page would make the reader rebuild the filter by hand.
    expect(html).toContain('href="/analytics/redirects?');
    expect(html).toContain('domain=example.com');
    expect(html).toContain('country=SG');
    expect(html).toContain('search=%2Fwelcome');
    expect(html).toContain('days=7');
    expect(html).toContain('includeMonitoring=true');
    // The label is a real link, not the previous inert text.
    expect(html).toContain('View redirect click analytics for https://example.com/welcome');
  });

  it('renders leaderboard metadata at the accessible contrast token', () => {
    // charcoal-400 failed a live mobile accessibility gate; charcoal-500 is the
    // level that passed. Guard it so a future palette tidy-up cannot quietly
    // walk it back.
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(html).toContain('text-tiny text-charcoal-500');
    expect(html).not.toContain('text-charcoal-400');
  });

  it('renders an actionable error state without hiding the page controls', () => {
    mockUseAnalyticsSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error('request failed'),
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/?includeMonitoring=true']}>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(html).toContain('Failed to load analytics: request failed');
    expect(html).toContain('Include Cloudflare Health Checks');
  });
});
