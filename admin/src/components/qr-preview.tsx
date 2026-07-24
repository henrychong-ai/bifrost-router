/**
 * Live QR preview (v1.54.0). Renders CLIENT-SIDE with the SAME shared renderer
 * the Worker uses (WYSIWYG by construction — locked plan decision), embedded
 * via an <img data:> URI rather than injected SVG markup (no DOM injection;
 * CSP img-src already allows data:).
 */

import { useMemo } from 'react';
import { renderQrSvg, type QRDesign } from '@bifrost/shared';
import { svgToDataUri } from '@/lib/svg-to-png';

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

  if (!dataUri) {
    return (
      <div
        className={className}
        style={{ width: displaySize, height: displaySize }}
        role="img"
        aria-label="QR preview unavailable"
      />
    );
  }

  return (
    <img
      src={dataUri}
      width={displaySize}
      height={displaySize}
      // Neutral alt (codex F6): the encoded content can carry Wi-Fi credentials —
      // keep them out of the DOM/accessibility tree.
      alt="QR code preview"
      className={className}
    />
  );
}
