import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedbackApi } from './api-client';
import { feedbackListParams } from './feedback-list';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://api.example.test' },
}));

describe('feedbackListParams (triage queue controls)', () => {
  it('sends nothing for the defaults, as earlier releases did', () => {
    expect(
      feedbackListParams({ status: 'all', type: 'all', priority: 'all', sort: 'newest' }),
    ).toEqual({});
  });

  it('sends each chosen filter and the oldest-first order', () => {
    expect(
      feedbackListParams({ status: 'new', type: 'bug', priority: '0', sort: 'oldest' }),
    ).toEqual({ status: 'new', type: 'bug', priority: 0, sort: 'oldest' });
    expect(
      feedbackListParams({ status: 'all', type: 'all', priority: '3', sort: 'newest' }),
    ).toEqual({ priority: 3 });
  });

  it('sends no priority for a value off the scale', () => {
    for (const priority of ['4', '-1', '', 'P0', '0.5']) {
      expect(feedbackListParams({ status: 'all', type: 'all', priority, sort: 'newest' })).toEqual(
        {},
      );
    }
  });
});

// The api client builds the URL from the params itself: a control the helper
// sets must reach the request, not stop at the type.
describe('feedbackApi.list sends the queue controls', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts the priority and the order on the request URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { feedback: [], total: 0 } }), {
        status: 200,
      }),
    );
    await feedbackApi.list(
      feedbackListParams({ status: 'new', type: 'all', priority: '1', sort: 'oldest' }),
    );
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/feedback');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'new',
      priority: '1',
      sort: 'oldest',
    });
  });
});
