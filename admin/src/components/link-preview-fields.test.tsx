// @vitest-environment happy-dom

/**
 * The route form's "Link preview" section (v1.48.0): each field reports its
 * edit, the image buckets offered are the deployment's preview image buckets
 * (those with a custom domain), and the section shows the field errors the
 * form's rules give (`previewFormErrors`, here against a blank form as a
 * create opens).
 */

import { R2_BUCKETS } from '@bifrost/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LivePreviewCard } from '@/lib/live-preview-card';
import { usePreviewBuckets } from '@/lib/preview-buckets.fixture';
import { NEW_ROUTE_FORM_VALUES, previewFormErrors, type RouteFormValues } from '@/lib/route-patch';
import { LinkPreviewFields, type LinkPreviewFieldValues } from './link-preview-fields';

usePreviewBuckets();

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const empty: LinkPreviewFieldValues = {
  previewTitle: '',
  previewDescription: '',
  previewImageBucket: '',
  previewImageKey: '',
  previewVideoWidth: '',
  previewVideoHeight: '',
};

/** A blank r2 form, as a create opens, with these preview values. */
const formWith = (values: Partial<LinkPreviewFieldValues>): RouteFormValues => ({
  ...NEW_ROUTE_FORM_VALUES,
  type: 'r2',
  ...values,
});

/** The field errors the form's rules give for these values. */
const errorsFor = (values: Partial<LinkPreviewFieldValues>) =>
  previewFormErrors(formWith({}), formWith(values), true);

type Patch = Partial<LinkPreviewFieldValues>;

async function render(
  values: Partial<LinkPreviewFieldValues> = {},
  extra: { card?: LivePreviewCard; fileIsImage?: boolean } = {},
) {
  const onChange = vi.fn<(patch: Patch) => void>();
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <LinkPreviewFields
          values={{ ...empty, ...values }}
          onChange={onChange}
          errors={errorsFor(values)}
          {...extra}
        />
      </TooltipProvider>,
    );
  });
  return onChange;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Type into a controlled input the way React listens for it. */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const textarea = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
const alertText = () => document.querySelector('[role="alert"]')?.textContent;

describe('LinkPreviewFields', () => {
  it('explains the card and its limits', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Link preview');
    expect(text).toContain('WhatsApp, LinkedIn, Slack, iMessage');
    expect(text).toContain('People who open the link still get the file');
    expect(input('previewTitle').maxLength).toBe(120);
    expect(textarea('previewDescription').maxLength).toBe(240);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports each edit', async () => {
    const onChange = await render();
    await typeInto(input('previewTitle'), 'Report');
    await typeInto(textarea('previewDescription'), 'The year');
    await typeInto(input('previewImageKey'), 'previews/a.png');
    await typeInto(input('previewVideoWidth'), '1920');
    await typeInto(input('previewVideoHeight'), '1080');
    await choose(select('previewImageBucket'), 'assets');
    expect(onChange.mock.calls.map(([patch]) => patch)).toEqual([
      { previewTitle: 'Report' },
      { previewDescription: 'The year' },
      { previewImageKey: 'previews/a.png' },
      { previewVideoWidth: '1920' },
      { previewVideoHeight: '1080' },
      { previewImageBucket: 'assets' },
    ]);
  });

  it('offers the buckets with a custom domain, and shows a stored one without, disabled', async () => {
    await render({ previewImageBucket: 'library' });
    const options = [...select('previewImageBucket').options].map(option => [
      option.value,
      option.disabled,
    ]);
    const offered = R2_BUCKETS.filter(bucket => bucket === 'files' || bucket === 'assets');
    expect(options).toEqual([
      ['', false],
      ['library', true],
      ...offered.map(bucket => [bucket, false]),
    ]);
    expect(document.body.textContent).not.toContain('No bucket has a custom domain');
  });

  it('"No image" clears the key as well as the bucket', async () => {
    const onChange = await render({ previewImageBucket: 'assets', previewImageKey: 'a.png' });
    await choose(select('previewImageBucket'), '');
    expect(onChange).toHaveBeenLastCalledWith({ previewImageBucket: '', previewImageKey: '' });
  });

  it('shows a field error for an invalid video size on that field', async () => {
    await render({ previewTitle: 'T', previewVideoWidth: '99999', previewVideoHeight: '1080' });
    expect(alertText()).toContain('1 to 7680');
    expect(input('previewVideoWidth').getAttribute('aria-invalid')).toBe('true');
    expect(input('previewVideoHeight').getAttribute('aria-invalid')).toBe('false');
  });

  it('a video size without the other is a field error on the missing one', async () => {
    await render({ previewTitle: 'T', previewVideoWidth: '1920', previewVideoHeight: '' });
    expect(alertText()).toContain('both the video width');
    expect(input('previewVideoWidth').getAttribute('aria-invalid')).toBe('false');
    expect(input('previewVideoHeight').getAttribute('aria-invalid')).toBe('true');
  });

  it('erasing the image key keeps the bucket', async () => {
    const onChange = await render({
      previewTitle: 'T',
      previewImageBucket: 'assets',
      previewImageKey: 'a.png',
    });
    await typeInto(input('previewImageKey'), '');
    expect(onChange).toHaveBeenLastCalledWith({ previewImageKey: '' });
  });

  it('a bucket without a key, or a key without a bucket, is the image field error', async () => {
    await render({ previewTitle: 'T', previewImageBucket: 'assets' });
    expect(alertText()).toBe('Choose a bucket and enter a key');
    expect(select('previewImageBucket').getAttribute('aria-invalid')).toBe('true');
    expect(input('previewImageKey').getAttribute('aria-invalid')).toBe('true');
    await render({ previewTitle: 'T', previewImageKey: 'a.png' });
    expect(alertText()).toBe('Choose a bucket and enter a key');
  });

  it('asks for a title when another field is filled', async () => {
    await render({ previewDescription: 'About' });
    expect(alertText()).toBe('Add a title');
    expect(input('previewTitle').getAttribute('aria-invalid')).toBe('true');
  });

  it('notes that an image file previews as itself', async () => {
    await render({}, { fileIsImage: true });
    expect(document.querySelector('[role="note"]')?.textContent).toContain('This file is an image');
  });

  it('shows the live card it is given, at the end of the section, and none without one', async () => {
    await render();
    expect(document.getElementById('link-preview-card-heading')).toBeNull();
    await render(
      {},
      {
        card: {
          send: true,
          card: { title: 'Live title' },
          imageCheckedOnSave: false,
          provisional: false,
        },
      },
    );
    const section = document.querySelector('section[aria-labelledby="link-preview-heading"]');
    expect(section?.lastElementChild?.textContent).toContain('Live title');
    await render({}, { card: { send: false, reason: 'Add a title' } });
    expect(section?.textContent).toContain('No card will be sent. Add a title.');
  });
});

describe('LinkPreviewFields on a deployment with no custom domain', () => {
  it('offers no bucket and says a card has no image', async () => {
    const { R2_BUCKET_CUSTOM_DOMAINS } = await import('@bifrost/shared');
    const saved = structuredClone(R2_BUCKET_CUSTOM_DOMAINS);
    for (const key of Object.keys(R2_BUCKET_CUSTOM_DOMAINS)) delete R2_BUCKET_CUSTOM_DOMAINS[key];
    try {
      await render();
      expect([...select('previewImageBucket').options].map(option => option.value)).toEqual(['']);
      expect(document.body.textContent).toContain('No bucket has a custom domain');
    } finally {
      Object.assign(R2_BUCKET_CUSTOM_DOMAINS, saved);
    }
  });
});
