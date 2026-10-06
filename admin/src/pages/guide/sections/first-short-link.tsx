import { FactChip, GuideSection, MediaSlot, Step, StepList, Tip } from '../guide-primitives';
import { GUIDE_SECTIONS } from '../guide-registry';

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
        <Step n={4} title="Optional: add UTM tracking">
          For a redirect or proxy, open <strong>UTM tracking</strong> under the target to set the
          campaign tags (source, medium, campaign, term, content). They are written into the target
          URL in lowercase; use kebab-case such as <FactChip>spring-launch-2026</FactChip>, never
          underscores or spaces. <strong>Final target</strong> shows exactly what is saved.
        </Step>
        <Step n={5} title="Create">
          The route is live on every edge location within seconds — no deploy, no waiting.
        </Step>
        <Step n={6} title="Copy the link or grab a QR code">
          From the route's row menu: <strong>Copy Link</strong>, or <strong>QR Code</strong> to
          download a print-ready SVG/PNG on the spot.
        </Step>
        <Step n={7} title="Watch it work">
          Clicks show up under Analytics → Redirects, and the summary cards on the Dashboard.
        </Step>
      </StepList>
      <Tip>
        Made a typo in the slug? Open <strong>Edit</strong> and change the Path — Bifrost migrates
        the route to the new slug, keeping its config and creation date (past click history stays
        under the old slug). Pointing it somewhere new is just Edit too — the short link never has
        to change. An edit saves only the fields you changed; saving with nothing changed says “No
        changes to save” and sends nothing.
      </Tip>
      <Tip>
        Naming a file link: name it after the document, not the file — no dates, versions or file
        extensions (<FactChip>/brochures/company-overview-en</FactChip>, not{' '}
        <FactChip>/20260923-brochure-final.pdf</FactChip>). The link then stays the same when you
        swap the file. The route dialog flags these as advice; it never blocks a save.
      </Tip>
    </GuideSection>
  );
}
