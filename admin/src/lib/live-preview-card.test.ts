/**
 * The route form's live link-preview card (v1.48.0): the decision
 * (`livePreviewCard`) and the record a save would leave (`previewRecordIfSaved`).
 * The agreement cases feed the same stored route to the card's decision
 * (through a form opened on it) and to the Worker's decision, built from the
 * shared functions the Worker calls (`servablePreview` with
 * `isServableR2Key`, `isCardEligibleFile`, `previewCard`), and require the
 * same answer.
 */
import {
  isCardEligibleFile,
  isServableR2Key,
  PREVIEW_DEFAULT_IMAGES,
  PREVIEW_TITLE_MAX_LENGTH,
  previewCard,
  servablePreview,
} from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import {
  type LivePreviewCard,
  livePreviewCard,
  NO_CARD_DESCRIPTION_UNSERVABLE,
  NO_CARD_DISABLED,
  NO_CARD_FILE_MISSING,
  NO_CARD_IMAGE_FILE,
  NO_CARD_IMAGE_UNSERVABLE,
  NO_CARD_NOT_FILE,
  NO_CARD_TITLE_UNSERVABLE,
  NO_CARD_VIDEO_UNSERVABLE,
  NO_CARD_WILDCARD,
  type PreviewFileStatus,
  previewFileStatus,
  previewRecordIfSaved,
} from './live-preview-card';
import { usePreviewBuckets } from './preview-buckets.fixture';
import {
  NEW_ROUTE_FORM_VALUES,
  PREVIEW_IMAGE_INCOMPLETE,
  PREVIEW_TITLE_NEEDED,
  type RouteFormValues,
  routeFormValues,
} from './route-patch';
import type { Route } from './schemas';

usePreviewBuckets();

const HOST = 'links.example.com';
const DEFAULT = { bucket: 'assets', key: 'previews/default.png', width: 1200, height: 630 };
const DEFAULTS = { [HOST]: DEFAULT };

const stored = (overrides: Partial<Route> = {}): Route => ({
  path: '/report',
  type: 'r2',
  target: 'docs/report.pdf',
  bucket: 'files',
  previewTitle: 'Annual report',
  previewDescription: 'The year in numbers',
  previewImageBucket: 'assets',
  previewImageKey: 'previews/report.jpg',
  previewImageWidth: 1200,
  previewImageHeight: 630,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

/** A create dialog's opening state, as an r2 route. */
const blankFile = (): RouteFormValues => ({
  ...NEW_ROUTE_FORM_VALUES,
  type: 'r2',
  target: 'docs/report.pdf',
});

/** The inputs a dialog passes beside the form state, as the page passes them. */
interface DialogOptions {
  defaults?: typeof DEFAULTS;
  host?: string;
  path?: string;
  contentType?: string;
  fileStatus?: PreviewFileStatus;
}

const dialogInputs = (options: DialogOptions, path: string) => ({
  host: options.host ?? HOST,
  path: options.path ?? path,
  storedContentType: options.contentType,
  fileStatus: options.fileStatus ?? ('found' as const),
  defaults: options.defaults ?? {},
});

const forCreate = (values: Partial<RouteFormValues>, options: DialogOptions = {}) =>
  livePreviewCard({
    opened: blankFile(),
    current: { ...blankFile(), ...values },
    stored: undefined,
    ...dialogInputs(options, '/new'),
  });

const forEdit = (
  route: Route,
  values: Partial<RouteFormValues> = {},
  options: DialogOptions = {},
) => {
  const opened = routeFormValues(route);
  return livePreviewCard({
    opened,
    current: { ...opened, ...values },
    stored: route,
    ...dialogInputs(options, route.path),
  });
};

const reason = (decision: LivePreviewCard) => (decision.send ? null : decision.reason);

describe('livePreviewCard: the card a save now would send', () => {
  it('shows the title, description and the image from its custom-domain address', () => {
    expect(forEdit(stored())).toEqual({
      send: true,
      card: {
        title: 'Annual report',
        description: 'The year in numbers',
        image: {
          url: 'https://assets.example.com/previews/report.jpg',
          width: 1200,
          height: 630,
          alt: 'Annual report',
        },
        imageSource: 'route',
      },
      // The stored image was measured when it was saved
      imageCheckedOnSave: false,
      provisional: false,
    });
  });

  it('follows the fields as they change, sanitised as the Worker sanitises them', () => {
    const decision = forEdit(stored(), {
      previewTitle: '  New\ttitle\r\n ',
      previewDescription: 'Line one\r\nline two\u0007',
    });
    expect(decision).toMatchObject({
      send: true,
      card: { title: 'New title', description: 'Line one\nline two' },
    });
  });

  it('claims no size for an image the save will measure, and says the save checks it', () => {
    const decision = forEdit(stored(), { previewImageKey: 'previews/other card.png' });
    expect(decision).toMatchObject({ send: true, imageCheckedOnSave: true });
    expect(decision.send && decision.card.image).toEqual({
      url: 'https://assets.example.com/previews/other%20card.png',
      alt: 'Annual report',
    });
  });

  it('a title alone gives a text-only card; with a domain default, the default image', () => {
    expect(forCreate({ previewTitle: 'Report' })).toEqual({
      send: true,
      card: { title: 'Report' },
      imageCheckedOnSave: false,
      provisional: false,
    });
    expect(forCreate({ previewTitle: 'Report' }, { defaults: DEFAULTS })).toMatchObject({
      send: true,
      card: {
        image: { url: 'https://assets.example.com/previews/default.png', alt: 'Report' },
        imageSource: 'default',
      },
      // A default is in the map with its measured size: nothing to check on save
      imageCheckedOnSave: false,
    });
    // The route's own image wins over the default
    expect(
      forCreate(
        { previewTitle: 'Report', previewImageBucket: 'assets', previewImageKey: 'own.jpg' },
        { defaults: DEFAULTS },
      ),
    ).toMatchObject({
      card: { image: { url: 'https://assets.example.com/own.jpg' } },
      imageCheckedOnSave: true,
    });
  });

  it('says why no card will be sent where the route cannot have one', () => {
    expect(reason(forCreate({ type: 'redirect', previewTitle: 'T' }))).toBe(NO_CARD_NOT_FILE);
    expect(reason(forCreate({ previewTitle: 'T' }, { path: '/docs/*' }))).toBe(NO_CARD_WILDCARD);
    expect(reason(forCreate({ target: 'photos/a.png', previewTitle: 'T' }))).toBe(
      NO_CARD_IMAGE_FILE,
    );
    // The stored content type is judged before the key's extension
    expect(reason(forCreate({ previewTitle: 'T' }, { contentType: 'image/webp' }))).toBe(
      NO_CARD_IMAGE_FILE,
    );
  });

  it("says why with the form's own error text while a field is invalid", () => {
    expect(reason(forCreate({}))).toBe(PREVIEW_TITLE_NEEDED);
    expect(reason(forCreate({ previewDescription: 'About' }))).toBe(PREVIEW_TITLE_NEEDED);
    expect(reason(forCreate({ previewTitle: 'T', previewImageBucket: 'assets' }))).toBe(
      PREVIEW_IMAGE_INCOMPLETE,
    );
    expect(reason(forCreate({ previewTitle: 'T', previewVideoWidth: 'wide' }))).toMatch(
      /^Enter a whole number/,
    );
    expect(reason(forCreate({ previewTitle: 'T', previewVideoWidth: '1920' }))).toMatch(
      /^Enter both the video width and height/,
    );
    // Clearing a stored title clears the whole preview: no card
    expect(reason(forEdit(stored(), { previewTitle: '   ' }))).toBe(PREVIEW_TITLE_NEEDED);
  });

  it('says no card for details a card cannot carry, naming the part at fault', () => {
    expect(
      reason(
        forCreate({
          previewTitle: 'T',
          previewImageBucket: 'assets',
          previewImageKey: '../previews/a.png',
        }),
      ),
    ).toBe(NO_CARD_IMAGE_UNSERVABLE);
    // A bucket with no custom domain cannot hold the image
    expect(
      reason(
        forCreate({ previewTitle: 'T', previewImageBucket: 'library', previewImageKey: 'a.png' }),
      ),
    ).toBe(NO_CARD_IMAGE_UNSERVABLE);
    expect(reason(forCreate({ previewTitle: 'x'.repeat(PREVIEW_TITLE_MAX_LENGTH + 1) }))).toBe(
      NO_CARD_TITLE_UNSERVABLE,
    );
  });

  it('an edit that leaves an out-of-shape stored preview alone sends no card, as today', () => {
    // A measured size is missing: the stored preview is not servable
    const broken = stored({ previewImageWidth: undefined, previewImageHeight: undefined });
    expect(reason(forEdit(broken))).toBe(NO_CARD_IMAGE_UNSERVABLE);
    // ... and a domain default never stands in for it
    expect(reason(forEdit(broken, {}, { defaults: DEFAULTS }))).toBe(NO_CARD_IMAGE_UNSERVABLE);
    // A stored title with padding is left as stored, and is not servable
    expect(reason(forEdit(stored({ previewTitle: ' padded ' })))).toBe(NO_CARD_TITLE_UNSERVABLE);
    // A stored description over its cap, and a stored video size out of range
    expect(reason(forEdit(stored({ previewDescription: 'x'.repeat(241) })))).toBe(
      NO_CARD_DESCRIPTION_UNSERVABLE,
    );
    expect(
      reason(
        forEdit(
          stored({ previewVideoWidth: 0, previewVideoHeight: 1080 }),
          {},
          { contentType: 'video/mp4' },
        ),
      ),
    ).toBe(NO_CARD_VIDEO_UNSERVABLE);
    // Re-entering the image fixes it: the save measures the image again
    expect(forEdit(broken, { previewImageKey: 'previews/fixed.jpg' }).send).toBe(true);
    // A stored title that is only whitespace counts as no title
    expect(reason(forEdit(stored({ previewTitle: '   ' })))).toBe(PREVIEW_TITLE_NEEDED);
  });
});

describe('livePreviewCard: what a save cannot deliver', () => {
  it('a confirmed-missing file has no card; an unconfirmed one is marked provisional', () => {
    expect(reason(forEdit(stored(), {}, { fileStatus: 'missing' }))).toBe(NO_CARD_FILE_MISSING);
    expect(forEdit(stored(), {}, { fileStatus: 'unconfirmed' })).toMatchObject({
      send: true,
      provisional: true,
    });
    expect(forEdit(stored())).toMatchObject({ send: true, provisional: false });
  });

  it('a disabled route has no card, whatever the fields', () => {
    expect(reason(forEdit(stored({ enabled: false }), { previewTitle: 'Renamed' }))).toBe(
      NO_CARD_DISABLED,
    );
    expect(reason(forCreate({ previewTitle: 'T', enabled: false }))).toBe(NO_CARD_DISABLED);
  });

  it('a legacy size with no image is dropped, as every write drops it: a text-only card', () => {
    const legacy = stored({
      previewImageBucket: undefined,
      previewImageKey: undefined,
      previewImageWidth: 1200,
    });
    expect(forEdit(legacy, { previewTitle: 'Renamed' })).toMatchObject({
      send: true,
      card: { title: 'Renamed' },
    });
    // Saved as it is, the size goes too, and the card is text only
    const unchanged = forEdit(legacy);
    expect(unchanged.send).toBe(true);
    expect(unchanged.send && unchanged.card.image).toBeUndefined();
  });

  it("reads the file's status from the read made for the form's current file", () => {
    expect(previewFileStatus({ settled: false, data: { size: 1 }, error: null })).toBe(
      'unconfirmed',
    );
    expect(previewFileStatus({ settled: true, data: { size: 1 }, error: null })).toBe('found');
    expect(previewFileStatus({ settled: true, data: undefined, error: { status: 404 } })).toBe(
      'missing',
    );
    for (const error of [{ status: 403 }, null, 'boom', { status: '404' }]) {
      expect(previewFileStatus({ settled: true, data: undefined, error })).toBe('unconfirmed');
    }
  });
});

describe('previewRecordIfSaved', () => {
  it('keeps unchanged fields as stored and sends only the changed ones, sanitised', () => {
    const route = stored({ previewVideoWidth: 1920, previewVideoHeight: 1080 });
    const opened = routeFormValues(route);
    expect(previewRecordIfSaved(opened, opened, route)).toEqual({
      record: {
        previewTitle: 'Annual report',
        previewDescription: 'The year in numbers',
        previewImageBucket: 'assets',
        previewImageKey: 'previews/report.jpg',
        previewImageWidth: 1200,
        previewImageHeight: 630,
        previewVideoWidth: 1920,
        previewVideoHeight: 1080,
      },
      imageMeasuredOnSave: false,
    });
    const changed = previewRecordIfSaved(
      opened,
      { ...opened, previewDescription: '  ', previewVideoWidth: '', previewVideoHeight: '' },
      route,
    );
    expect(changed.record).not.toHaveProperty('previewDescription');
    expect(changed.record).not.toHaveProperty('previewVideoWidth');
    expect(changed.record).not.toHaveProperty('previewVideoHeight');
    expect(
      previewRecordIfSaved(opened, { ...opened, previewVideoWidth: '1280' }, route).record,
    ).toMatchObject({ previewVideoWidth: 1280, previewVideoHeight: 1080 });
  });

  it('a changed image is measured on save; an emptied one is removed with its size', () => {
    const route = stored();
    const opened = routeFormValues(route);
    expect(
      previewRecordIfSaved(opened, { ...opened, previewImageBucket: 'files' }, route),
    ).toMatchObject({
      record: { previewImageBucket: 'files', previewImageKey: 'previews/report.jpg' },
      imageMeasuredOnSave: true,
    });
    const removed = previewRecordIfSaved(
      opened,
      { ...opened, previewImageBucket: '', previewImageKey: '' },
      route,
    );
    expect(removed).toEqual({
      record: { previewTitle: 'Annual report', previewDescription: 'The year in numbers' },
      imageMeasuredOnSave: false,
    });
  });

  it('a blanked title clears every field', () => {
    const route = stored();
    const opened = routeFormValues(route);
    expect(previewRecordIfSaved(opened, { ...opened, previewTitle: '' }, route)).toEqual({
      record: {},
      imageMeasuredOnSave: false,
    });
  });
});

/**
 * The Worker's decision for a stored route, from the same shared functions
 * the serving branch calls.
 */
function workerCard(route: Route, host: string, contentType: string, defaults = {}) {
  const servable = servablePreview({ ...route }, isServableR2Key);
  if (!servable || !isCardEligibleFile(route, contentType)) return null;
  return previewCard(servable, host, defaults);
}

describe('the live card agrees with the Worker for an unchanged stored route', () => {
  const cases: [string, Route, string][] = [
    ['an own image', stored(), 'application/pdf'],
    [
      'a title only',
      stored({
        previewDescription: undefined,
        previewImageBucket: undefined,
        previewImageKey: undefined,
        previewImageWidth: undefined,
        previewImageHeight: undefined,
      }),
      'application/pdf',
    ],
    ['a video size', stored({ previewVideoWidth: 1920, previewVideoHeight: 1080 }), 'video/mp4'],
    ['no size for the image', stored({ previewImageWidth: undefined }), 'application/pdf'],
    ['an image key the writer refuses', stored({ previewImageKey: '/a.png' }), 'application/pdf'],
    ['a padded title', stored({ previewTitle: ' T ' }), 'application/pdf'],
    ['an over-long title', stored({ previewTitle: 'x'.repeat(121) }), 'application/pdf'],
    ['half a video size', stored({ previewVideoWidth: 1920 }), 'video/mp4'],
    [
      'a video size out of range',
      stored({ previewVideoWidth: 0, previewVideoHeight: 1080 }),
      'video/mp4',
    ],
    ['an image file', stored({ target: 'a.png' }), 'image/png'],
    ['a wildcard route', stored({ path: '/docs/*' }), 'application/pdf'],
    ['no title', stored({ previewTitle: undefined }), 'application/pdf'],
  ];

  for (const defaults of [{}, DEFAULTS, PREVIEW_DEFAULT_IMAGES]) {
    it.each(cases)(`%s (defaults: ${Object.keys(defaults).length} entries)`, (_, route, type) => {
      const worker = workerCard(route, HOST, type, defaults);
      const live = forEdit(route, {}, { contentType: type, defaults: defaults as typeof DEFAULTS });
      expect(live.send ? live.card : null).toEqual(worker);
    });
  }
});
