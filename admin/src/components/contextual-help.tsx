import { Link } from 'react-router-dom';
import { CircleHelp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Contextual help affordance (plan Phase 2): a small ? icon in page headers
 * deep-linking to the matching User Guide section (/guide#<anchor>). Anchors
 * are the section ids in pages/guide/guide-registry.ts.
 */
export function ContextualHelp({ anchor, label }: { anchor: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={`/guide#${anchor}`}
          aria-label={`Open the user guide: ${label}`}
          className="
            text-charcoal-400 transition-colors
            hover:text-blue-600
          "
        >
          <CircleHelp className="size-4" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">Learn about {label} in the User Guide</TooltipContent>
    </Tooltip>
  );
}
