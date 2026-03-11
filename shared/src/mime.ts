/**
 * MIME type detection from file extensions
 *
 * Workers-compatible (no Node.js APIs). Used by both the Worker
 * (R2 file serving) and MCP servers (upload content_type auto-detection).
 */

export const EXTENSION_MIME_MAP: Record<string, string> = {
  // Documents
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  md: 'text/markdown',

  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',

  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',

  // Text
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',

  // Fonts
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
};

/**
 * Detect MIME type from an R2 object key's file extension.
 * Returns null if the extension is not recognised.
 */
export function getContentTypeFromKey(key: string): string | null {
  const ext = key.split('.').pop()?.toLowerCase();
  return ext ? (EXTENSION_MIME_MAP[ext] ?? null) : null;
}
