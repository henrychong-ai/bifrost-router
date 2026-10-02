/**
 * Live QR preview (v1.54.0). Renders CLIENT-SIDE with the SAME shared renderer
 * the Worker uses (WYSIWYG by construction — locked plan decision), embedded
 * via an <img data:> URI rather than injected SVG markup (no DOM injection;
 * CSP img-src already allows data:).
 */

import { type QRDesign, renderQrSvg } from '@bifrost/shared';
import { useMemo } from 'react';
import { svgToDataUri } from '@/lib/svg-to-png';

/** A blank, transparent image: the unavailable state keeps the preview's box. */
const BLANK_IMAGE = svgToDataUri('<svg xmlns="http://www.w3.org/2000/svg"/>');

interface QrPreviewProps {
  /** The exact string the QR encodes (already serialized/resolved). */
  content: string;
  design: QRDesign;
  /** Rendered box size in px (the design.size still controls the SVG itself). */
  displaySize?: number;
  className?: string;
}

export function QrPreview({ content, design, displaySize = 192, className }: QrPreviewProps) {
  const dataUri = useMemo(() => {
    try {
      return svgToDataUri(renderQrSvg(content, design));
    } catch {
      return null;
    }
  }, [content, design]);

  return (
    <img
      src={dataUri ?? BLANK_IMAGE}
      width={displaySize}
      height={displaySize}
      // Neutral alt (codex F6): the encoded content can carry Wi-Fi credentials —
      // keep them out of the DOM/accessibility tree.
      alt={dataUri ? 'QR code preview' : 'QR preview unavailable'}
      className={className}
    />
  );
}
