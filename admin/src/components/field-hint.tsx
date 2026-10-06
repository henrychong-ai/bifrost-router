import { Info } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Form label with an inline explanatory tooltip.
 *
 * Introduced when the QR dialog's field labels had accumulated their own
 * documentation — "Custom id (optional)", "Logo (PNG/JPEG/SVG, max 100 KB —
 * forces EC to H)". Implementation detail in a label is noise for the people
 * who already know and insufficient for those who don't; a tooltip carries the
 * full explanation without crowding the form.
 */
export function FieldHint({
  htmlFor,
  label,
  hint,
}: {
  htmlFor?: string;
  label: string;
  hint: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <InfoHint label={label} hint={hint} />
    </div>
  );
}

/** The info button and tooltip alone, for controls other than labels (v1.38.0). */
export function InfoHint({ label, hint }: { label: string; hint: string }): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Tooltips are hover/focus-only, so the button must not steal a
          // click or submit the surrounding form.
          onClick={e => e.preventDefault()}
          className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`About ${label}`}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="font-inter text-xs wrap-break-word">{hint}</p>
      </TooltipContent>
    </Tooltip>
  );
}
