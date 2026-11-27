/**
 * The one HTML escaper for Worker-built pages (the link-preview document,
 * v1.48.0). It escapes
 * `&`, `<`, `>`, `"` and `'`, which makes the result safe both as element
 * text and inside a double- or single-quoted attribute value. Never use it
 * for an unquoted attribute, a URL scheme decision, a script or a style.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
