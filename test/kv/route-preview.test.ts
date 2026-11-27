/**
 * How the link-preview fields are written (v1.48.0): create normalisation
 * and the patch merge, including the branches the API tests reach only in
 * combination.
 */
import { describe, expect, it } from 'vitest';
import { applyPreviewPatch, normalizeNewPreview } from '../../src/kv/route-preview';
import { applyRoutePatch } from '../../src/kv/routes';
import type { KVRouteConfig } from '../../src/types';

const stored: KVRouteConfig = {
  path: '/a',
  type: 'r2',
  target: 'a.pdf',
  previewTitle: 'Title',
  previewDescription: 'Description',
  previewImageBucket: 'assets',
  previewImageKey: 'a.png',
  previewImageWidth: 1200,
  previewImageHeight: 630,
  previewVideoWidth: 1920,
  previewVideoHeight: 1080,
  createdAt: 1,
  updatedAt: 1,
};

describe('normalizeNewPreview', () => {
  it('drops empty text, a null video size, and the whole image when its bucket or key is empty', () => {
    expect(
      normalizeNewPreview({
        path: '/a',
        previewTitle: ' T ',
        previewDescription: '',
        previewImageBucket: '',
        previewImageKey: 'a.png',
        previewImageWidth: 5,
        previewImageHeight: 5,
        previewVideoWidth: null,
      }),
    ).toEqual({ path: '/a', previewTitle: 'T' });
  });

  it('keeps a complete image with its size, and leaves a route without preview fields alone', () => {
    const input = {
      path: '/a',
      previewTitle: 'T',
      previewImageBucket: 'assets',
      previewImageKey: 'a.png',
      previewImageWidth: 10,
      previewImageHeight: 20,
    };
    expect(normalizeNewPreview(input)).toEqual(input);
    expect(normalizeNewPreview({ path: '/b' })).toEqual({ path: '/b' });
  });
});

describe('applyRoutePatch preview fields', () => {
  it('a patch without preview fields keeps them all', () => {
    expect(applyRoutePatch(stored, { enabled: false })).toEqual({ ...stored, enabled: false });
  });

  it('a whitespace title clears every preview field, other preview fields in the patch included', () => {
    const merged = applyRoutePatch(stored, { previewTitle: ' ', previewDescription: 'New' });
    expect(Object.keys(merged).filter(key => key.startsWith('preview'))).toEqual([]);
  });

  it('sanitises a new title and description', () => {
    expect(
      applyRoutePatch(stored, { previewTitle: ' New\ttitle ', previewDescription: ' x\u0000y ' }),
    ).toMatchObject({ previewTitle: 'New title', previewDescription: 'xy' });
  });

  it('a changed image without a fresh size drops the stored size', () => {
    const merged = applyRoutePatch(stored, { previewImageKey: 'b.png' });
    expect(merged.previewImageKey).toBe('b.png');
    expect(merged).not.toHaveProperty('previewImageWidth');
    expect(merged).not.toHaveProperty('previewImageHeight');
  });

  it('a changed image with a fresh size keeps the new size', () => {
    expect(
      applyRoutePatch(stored, {
        previewImageKey: 'b.png',
        previewImageWidth: 300,
        previewImageHeight: 200,
      }),
    ).toMatchObject({ previewImageKey: 'b.png', previewImageWidth: 300, previewImageHeight: 200 });
  });

  it.each([['previewImageBucket'], ['previewImageKey']])(
    'an empty %s alone clears both image fields and both measured sizes',
    field => {
      const merged = { ...stored } as KVRouteConfig;
      applyPreviewPatch(merged, { [field]: '' });
      for (const gone of [
        'previewImageBucket',
        'previewImageKey',
        'previewImageWidth',
        'previewImageHeight',
      ]) {
        expect(merged).not.toHaveProperty(gone);
      }
      expect(merged.previewTitle).toBe('Title');
    },
  );

  it('an empty key on create drops the bucket given beside it', () => {
    expect(
      normalizeNewPreview({
        path: '/a',
        previewTitle: 'T',
        previewImageBucket: 'assets',
        previewImageKey: '',
      }),
    ).toEqual({ path: '/a', previewTitle: 'T' });
  });

  it('null clears a video size; a number sets it', () => {
    expect(
      applyRoutePatch(stored, { previewVideoWidth: null, previewVideoHeight: null }),
    ).not.toHaveProperty('previewVideoWidth');
    expect(applyRoutePatch(stored, { previewVideoWidth: 640 }).previewVideoWidth).toBe(640);
  });
});
