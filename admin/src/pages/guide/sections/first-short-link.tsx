import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, MediaSlot, Step, StepList, Tip } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'first-short-link')!;

export function FirstShortLinkSection() {
  return (
    <GuideSection
      meta={meta}
      description="End-to-end in under a minute — create a branded short link and hand it out."
    >
      <MediaSlot slotId="first-short-link" />
      <StepList>
        <Step n={1} title="Open Routes and click New Route">
          Or press <FactChip>n</FactChip> anywhere on the Routes page.
        </Step>
        <Step n={2} title="Pick the domain and path">
          The domain dropdown lists every supported domain. The path is your slug, e.g.{' '}
          <FactChip>/summit</FactChip> — paths are always lowercase.
        </Step>
        <Step n={3} title="Choose type: redirect, and paste the target URL">
          A live link preview appears so you can confirm the target is right. Bifrost also warns if
          another route already points at the same target.
        </Step>
        <Step n={4} title="Create">
          The route is live on every edge location within seconds — no deploy, no waiting.
        </Step>
        <Step n={5} title="Copy the link or grab a QR code">
          From the route's row menu: <strong>Copy Link</strong>, or <strong>QR Code</strong> to
          download a print-ready SVG/PNG on the spot.
        </Step>
        <Step n={6} title="Watch it work">
          Clicks show up under Analytics → Redirects, and the summary cards on the Dashboard.
        </Step>
      </StepList>
      <Tip>
        Made a typo in the slug? Open <strong>Edit</strong> and change the Path — Bifrost migrates
        the route to the new slug, keeping its config and creation date (past click history stays
        under the old slug). Pointing it somewhere new is just Edit too — the short link never has
        to change.
      </Tip>
    </GuideSection>
  );
}
