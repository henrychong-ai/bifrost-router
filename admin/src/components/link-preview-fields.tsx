import {
  PREVIEW_DESCRIPTION_MAX_LENGTH,
  PREVIEW_IMAGE_KEY_MAX_LENGTH,
  PREVIEW_IMAGE_MAX_KB,
  PREVIEW_TITLE_MAX_LENGTH,
  PREVIEW_VIDEO_DIMENSION_MAX,
  previewImageBuckets,
} from '@bifrost/shared';
import { FieldHint } from '@/components/field-hint';
import { LinkPreviewCard } from '@/components/link-preview-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { LivePreviewCard } from '@/lib/live-preview-card';
import type { PreviewFieldErrors, RouteFormValues } from '@/lib/route-patch';

/** The form fields this section edits. */
export type LinkPreviewFieldValues = Pick<
  RouteFormValues,
  | 'previewTitle'
  | 'previewDescription'
  | 'previewImageBucket'
  | 'previewImageKey'
  | 'previewVideoWidth'
  | 'previewVideoHeight'
>;

/**
 * The "Link preview" section of the r2 route form (v1.48.0): what WhatsApp,
 * LinkedIn, Slack, iMessage and similar show when the link is shared. People
 * who open the link still get the file. Shown only for an r2 route that
 * serves one file (the Worker refuses preview details on a wildcard route).
 *
 * The image buckets offered are the deployment's preview image buckets
 * (`previewImageBuckets()`, the buckets in `R2_BUCKET_CUSTOM_DOMAINS`); a
 * stored bucket no longer among them is still listed, disabled, so it shows.
 * `errors` are the form's field errors (`previewFormErrors`), shown as given.
 * `card` is the live card (`livePreviewCard`): what a save now would send.
 */
export function LinkPreviewFields({
  values,
  onChange,
  errors,
  fileIsImage = false,
  card,
  disabled = false,
}: {
  values: LinkPreviewFieldValues;
  onChange: (patch: Partial<LinkPreviewFieldValues>) => void;
  errors: PreviewFieldErrors;
  /** The route's file is an image: it previews as itself, and no card is sent. */
  fileIsImage?: boolean;
  /** The live card; absent shows none. */
  card?: LivePreviewCard;
  disabled?: boolean;
}): React.ReactElement {
  const buckets: readonly string[] = previewImageBuckets();
  const stored = values.previewImageBucket;
  const storedOutside = stored !== '' && !buckets.includes(stored);
  const {
    title: titleError,
    image: imageError,
    videoWidth: widthError,
    videoHeight: heightError,
  } = errors;

  return (
    <section
      aria-labelledby="link-preview-heading"
      className="space-y-3 rounded-lg border border-charcoal-200 p-3"
    >
      <div className="space-y-0.5">
        <h3 id="link-preview-heading" className="font-inter text-sm font-medium text-charcoal-700">
          Link preview
        </h3>
        <p className="font-inter text-tiny text-muted-foreground">
          Optional. The card WhatsApp, LinkedIn, Slack, iMessage and similar apps show when this
          link is shared. People who open the link still get the file. Leave the title empty for no
          card; clearing the title clears every field below.
        </p>
      </div>

      {fileIsImage && (
        <p role="note" className="font-inter text-tiny text-muted-foreground">
          This file is an image: a shared link already shows the image itself, so these details are
          not sent as a card.
        </p>
      )}

      <div className="space-y-1">
        <FieldHint
          htmlFor="previewTitle"
          label="Title"
          hint={`Up to ${PREVIEW_TITLE_MAX_LENGTH} characters, on one line. Required for a card.`}
        />
        <Input
          id="previewTitle"
          value={values.previewTitle}
          maxLength={PREVIEW_TITLE_MAX_LENGTH}
          disabled={disabled}
          aria-invalid={titleError !== null}
          onChange={e => onChange({ previewTitle: e.target.value })}
          placeholder="Annual report 2026"
        />
        {titleError && (
          <p role="alert" className="text-sm text-destructive">
            {titleError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <FieldHint
          htmlFor="previewDescription"
          label="Description"
          hint={`Up to ${PREVIEW_DESCRIPTION_MAX_LENGTH} characters. Shown under the title on most platforms.`}
        />
        <Textarea
          id="previewDescription"
          value={values.previewDescription}
          maxLength={PREVIEW_DESCRIPTION_MAX_LENGTH}
          disabled={disabled}
          onChange={e => onChange({ previewDescription: e.target.value })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <FieldHint
            htmlFor="previewImageBucket"
            label="Image bucket"
            hint="A bucket with its own web address (an R2 custom domain), so platforms can load the image."
          />
          <select
            id="previewImageBucket"
            value={values.previewImageBucket}
            disabled={disabled}
            aria-invalid={imageError !== null}
            onChange={e =>
              // "No image" is the one choice that clears the key too
              onChange(
                e.target.value === ''
                  ? { previewImageBucket: '', previewImageKey: '' }
                  : { previewImageBucket: e.target.value },
              )
            }
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm"
          >
            <option value="">No image</option>
            {storedOutside && (
              <option value={stored} disabled>
                {stored} (no custom domain)
              </option>
            )}
            {buckets.map(bucket => (
              <option key={bucket} value={bucket}>
                {bucket}
              </option>
            ))}
          </select>
          {buckets.length === 0 && (
            <p className="font-inter text-tiny text-muted-foreground">
              No bucket has a custom domain in this deployment, so a card has no image.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <FieldHint
            htmlFor="previewImageKey"
            label="Image key"
            hint={`A JPEG or PNG of at most ${PREVIEW_IMAGE_MAX_KB} KB, ideally 1200 x 630 pixels. Upload it on the Storage page first; its size is read from the file when you save.`}
          />
          <Input
            id="previewImageKey"
            value={values.previewImageKey}
            maxLength={PREVIEW_IMAGE_KEY_MAX_LENGTH}
            disabled={disabled}
            aria-invalid={imageError !== null}
            // The key alone: erasing it keeps the bucket, so a new key replaces the image
            onChange={e => onChange({ previewImageKey: e.target.value })}
            placeholder="previews/annual-report-1200x630.jpg"
            className="font-mono"
          />
        </div>
        {imageError && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {imageError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label className="font-inter text-small text-charcoal-700">
          Video size (MP4 or WebM files only)
        </Label>
        <p className="font-inter text-tiny text-muted-foreground">
          Optional width and height in pixels (up to {PREVIEW_VIDEO_DIMENSION_MAX}). With both set,
          Discord and iMessage can play the video in the card; other platforms show the image.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="previewVideoWidth"
            aria-label="Video width"
            inputMode="numeric"
            value={values.previewVideoWidth}
            disabled={disabled}
            aria-invalid={widthError !== null}
            onChange={e => onChange({ previewVideoWidth: e.target.value })}
            placeholder="1920"
          />
          <Input
            id="previewVideoHeight"
            aria-label="Video height"
            inputMode="numeric"
            value={values.previewVideoHeight}
            disabled={disabled}
            aria-invalid={heightError !== null}
            onChange={e => onChange({ previewVideoHeight: e.target.value })}
            placeholder="1080"
          />
        </div>
        {(widthError ?? heightError) && (
          <p role="alert" className="text-sm text-destructive">
            {widthError ?? heightError}
          </p>
        )}
      </div>

      {card && <LinkPreviewCard decision={card} />}
    </section>
  );
}
