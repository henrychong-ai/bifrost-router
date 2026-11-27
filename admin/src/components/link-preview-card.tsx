import { useState } from 'react';
import { useDebounce } from '@/hooks/use-debounce';
import type { LivePreviewCard } from '@/lib/live-preview-card';

/** How long an image address must stay unchanged before the card loads it. */
export const CARD_IMAGE_SETTLE_MS = 400;

/** A reason as a sentence: the form's error texts do not all end in a full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The card image from its public address (the address the card carries),
 * fitted inside a fixed 1200 x 630 frame without stretching or cropping,
 * whatever its shape. Its size is never claimed: a new image is measured
 * only when the route is saved. Keyed on the address by the caller, so a new
 * address tries again after a failure.
 */
function CardImage({ url, alt }: { url: string; alt: string }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="border-b border-charcoal-200 p-2.5 font-inter text-tiny text-muted-foreground">
        The image could not be loaded from its public address, which is where platforms load it from
        too.
      </p>
    );
  }
  return (
    <div className="aspect-1200/630 w-full border-b border-charcoal-200 bg-charcoal-100">
      <img
        src={url}
        alt={alt}
        className="size-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/**
 * The route form's live link-preview card: what a platform would
 * receive if the form were saved now (`livePreviewCard`), updated as the
 * fields change, or a line saying no card will be sent and why.
 * Presentational: a labelled region, with the image's alternative text equal
 * to the title, as the served card has.
 */
export function LinkPreviewCard({ decision }: { decision: LivePreviewCard }): React.ReactElement {
  // The image loads once its address has settled, so typing a key sends no
  // request per keystroke; until then the frame stays empty
  const imageUrl = decision.send ? decision.card.image?.url : undefined;
  const settledUrl = useDebounce(imageUrl, CARD_IMAGE_SETTLE_MS);
  return (
    <section aria-labelledby="link-preview-card-heading" className="space-y-1.5">
      <div className="space-y-0.5">
        <h4
          id="link-preview-card-heading"
          className="font-inter text-small font-medium text-charcoal-700"
        >
          Card preview
        </h4>
        <p className="font-inter text-tiny text-muted-foreground">
          What platforms receive if you save now. Each app lays the card out in its own way.
        </p>
      </div>
      {decision.send ? (
        <div className="max-w-sm overflow-hidden rounded-lg border border-charcoal-200 bg-muted/30">
          {decision.card.image &&
            (settledUrl === decision.card.image.url ? (
              <CardImage
                key={decision.card.image.url}
                url={decision.card.image.url}
                alt={decision.card.image.alt}
              />
            ) : (
              <div
                aria-hidden="true"
                className="aspect-1200/630 w-full border-b border-charcoal-200 bg-charcoal-100"
              />
            ))}
          <div className="min-w-0 space-y-0.5 p-2.5">
            {decision.card.siteName && (
              <p className="font-inter text-tiny text-charcoal-500 uppercase">
                {decision.card.siteName}
              </p>
            )}
            <p className="font-inter text-small font-medium wrap-break-word text-charcoal-800">
              {decision.card.title}
            </p>
            {decision.card.description && (
              <p className="line-clamp-3 font-inter text-tiny wrap-break-word whitespace-pre-line text-charcoal-500">
                {decision.card.description}
              </p>
            )}
            {decision.imageCheckedOnSave && (
              <p className="font-inter text-tiny text-muted-foreground">
                The image is checked when you save: the file must exist in its bucket and be a JPEG
                or PNG within the size and pixel limits.
              </p>
            )}
            {decision.provisional && (
              <p className="font-inter text-tiny text-muted-foreground">
                The route's file has not been confirmed yet: platforms get this card only if the
                file exists.
              </p>
            )}
            {decision.card.imageSource === 'default' && (
              <p className="font-inter text-tiny text-muted-foreground">
                The image is this domain's default card image.
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="font-inter text-tiny text-muted-foreground">
          No card will be sent. {sentence(decision.reason)}
        </p>
      )}
    </section>
  );
}
