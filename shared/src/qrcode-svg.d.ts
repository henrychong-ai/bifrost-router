/**
 * Minimal module declaration for `qrcode-svg` (v1.1.0 ships no types).
 * Covers only the options + method the shared renderer uses.
 */
declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'Q' | 'H';
    join?: boolean;
    predefined?: boolean;
    pretty?: boolean;
    swap?: boolean;
    xmlDeclaration?: boolean;
    container?: 'svg' | 'svg-viewbox' | 'g' | 'none';
  }

  class QRCode {
    constructor(options: QRCodeOptions | string);
    svg(): string;
  }

  export = QRCode;
}
