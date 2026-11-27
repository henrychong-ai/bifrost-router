// @vitest-environment happy-dom

/**
 * The route form's live link-preview card (v1.48.0): it shows the title,
 * description, site name and image a save now would send, the image from
 * its public address with the title as its alternative text, inside a fixed
 * frame and with no claimed size; or the no-card line with its reason.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LivePreviewCard } from '@/lib/live-preview-card';
import { CARD_IMAGE_SETTLE_MS, LinkPreviewCard } from './link-preview-card';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(decision: LivePreviewCard) {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<LinkPreviewCard decision={decision} />);
  });
}

/** Let the image address settle, as it does once typing stops. */
const settle = () =>
  act(async () => {
    vi.advanceTimersByTime(CARD_IMAGE_SETTLE_MS);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  vi.useRealTimers();
  container?.remove();
  root = undefined;
  container = undefined;
});

const region = () =>
  document.querySelector('section[aria-labelledby="link-preview-card-heading"]') as HTMLElement;

const card: Extract<LivePreviewCard, { send: true }> = {
  send: true,
  card: {
    title: 'Annual report',
    description: 'The year in numbers',
    siteName: 'Example Links',
    image: { url: 'https://assets.example.com/previews/a.jpg', alt: 'Annual report' },
    imageSource: 'route',
  },
  imageCheckedOnSave: false,
  provisional: false,
};

describe('LinkPreviewCard', () => {
  it('is a labelled region showing the title, description, site name and image', async () => {
    await render(card);
    expect(document.getElementById('link-preview-card-heading')?.textContent).toBe('Card preview');
    const text = region().textContent ?? '';
    expect(text).toContain('Annual report');
    expect(text).toContain('The year in numbers');
    expect(text).toContain('Example Links');
    expect(text).not.toContain('default card image');
    const image = region().querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://assets.example.com/previews/a.jpg');
    expect(image.alt).toBe('Annual report');
    // No claimed size: the image fits a fixed frame without stretching
    expect(image.hasAttribute('width')).toBe(false);
    expect(image.hasAttribute('height')).toBe(false);
    expect(image.className).toContain('object-contain');
    expect(image.parentElement?.className).toContain('aspect-1200/630');
    expect(text).not.toContain('checked when you save');
    expect(text).not.toContain('not been confirmed');
  });

  it("says when the route's file is not confirmed yet", async () => {
    await render({ ...card, provisional: true });
    expect(region().textContent).toContain(
      "The route's file has not been confirmed yet: platforms get this card only if the file exists.",
    );
  });

  it('loads a new image only once its address settles, and says the save checks it', async () => {
    await render(card);
    for (const url of ['https://assets.example.com/p', 'https://assets.example.com/pr']) {
      await render({
        ...card,
        card: { ...card.card, image: { url, alt: 'Annual report' } },
        imageCheckedOnSave: true,
      });
      // While typing: the frame, no image and so no request
      expect(region().querySelector('img')).toBeNull();
      expect(region().querySelector('[aria-hidden="true"]')?.className).toContain(
        'aspect-1200/630',
      );
    }
    await settle();
    expect(region().querySelector('img')?.getAttribute('src')).toBe(
      'https://assets.example.com/pr',
    );
    expect(region().textContent).toContain(
      'The image is checked when you save: the file must exist in its bucket and be a JPEG or PNG within the size and pixel limits.',
    );
  });

  it('a text-only card has no image; a default image is named as such', async () => {
    await render({
      send: true,
      card: { title: 'Report' },
      imageCheckedOnSave: false,
      provisional: false,
    });
    expect(region().querySelector('img')).toBeNull();
    expect(region().textContent).toContain('Report');
    await render({
      send: true,
      card: {
        title: 'Report',
        image: { url: 'https://assets.example.com/d.png', alt: 'Report', width: 1200, height: 630 },
        imageSource: 'default',
      },
      imageCheckedOnSave: false,
      provisional: false,
    });
    await settle();
    expect(region().textContent).toContain("The image is this domain's default card image.");
    expect(region().querySelector('img')?.hasAttribute('width')).toBe(false);
  });

  it('updates as the decision changes', async () => {
    await render(card);
    await render({
      ...card,
      card: {
        ...card.card,
        title: 'Renamed',
        image: { url: 'https://assets.example.com/previews/a.jpg', alt: 'Renamed' },
      },
    });
    expect(region().textContent).toContain('Renamed');
    expect(region().querySelector('img')?.alt).toBe('Renamed');
  });

  it('says when the image cannot be loaded, and tries a new address again', async () => {
    await render(card);
    await act(async () => {
      region().querySelector('img')?.dispatchEvent(new Event('error'));
    });
    expect(region().querySelector('img')).toBeNull();
    expect(region().textContent).toContain('The image could not be loaded from its public address');
    await render({
      ...card,
      card: { ...card.card, image: { url: 'https://assets.example.com/b.jpg', alt: 'x' } },
    });
    await settle();
    expect(region().querySelector('img')?.getAttribute('src')).toBe(
      'https://assets.example.com/b.jpg',
    );
  });

  it('shows the no-card line with its reason, as a sentence', async () => {
    await render({ send: false, reason: 'Add a title' });
    expect(region().textContent).toContain('No card will be sent. Add a title.');
    expect(region().querySelector('img')).toBeNull();
    await render({ send: false, reason: 'Enter both, or leave both empty.' });
    expect(region().textContent).toContain(
      'No card will be sent. Enter both, or leave both empty.',
    );
    expect(region().textContent).not.toContain('empty..');
  });
});
