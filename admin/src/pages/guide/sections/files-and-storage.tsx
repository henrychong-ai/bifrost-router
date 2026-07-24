import { GUIDE_SECTIONS } from '../guide-registry';
import { GuideSection, MediaSlot, Tip, Warn } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'files-and-storage')!;

export function FilesAndStorageSection() {
  return (
    <GuideSection
      meta={meta}
      description="A full file manager for every R2 bucket — uploads, comments, metadata, and instant serving."
    >
      <MediaSlot slotId="files-and-storage" />
      <p>
        The Storage page is a file browser over the R2 buckets you can access (your live bucket list
        is in the access panel above). Navigate folders, and use the row menu for{' '}
        <strong>Download</strong>, <strong>Copy URL</strong>, <strong>Rename</strong>,{' '}
        <strong>Move</strong> (across buckets), <strong>Replace</strong>,{' '}
        <strong>Edit metadata</strong> (content type, caching, plus a free-text comment), and{' '}
        <strong>Delete</strong>. Click a file to see its details, an inline preview, and the routes
        that serve it — with a jump straight to those routes.
      </p>
      <p>
        <strong>Uploading:</strong> the upload dialog normalises file keys as you type (shown as a
        live "Saved as" preview) and can <strong>create a serving route in the same step</strong> —
        upload a PDF and walk away with a branded short link to it. Replacing an existing file
        automatically purges the CDN cache so the new version shows immediately; there is also a
        manual <strong>Purge Cache</strong> action if a stale copy ever lingers.
      </p>
      <Tip>
        Files in public buckets are served from a CDN — after replacing one, the auto-purge handles
        freshness. If a colleague still sees the old version, it is almost always their browser
        cache, not Bifrost.
      </Tip>
      <Warn>
        Deleting a file does not delete routes that point at it — those routes will start returning
        errors. The file detail dialog shows associated routes; check it before deleting.
      </Warn>
    </GuideSection>
  );
}
