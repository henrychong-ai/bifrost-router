import { FactChip, GuideSection, Tip } from '../guide-primitives';
import { GUIDE_SECTIONS } from '../guide-registry';

const meta = GUIDE_SECTIONS.find(s => s.id === 'qr-codes')!;

export function QrCodesSection() {
  return (
    <GuideSection
      meta={meta}
      description="Four QR types with live design preview — and the one doctrine that matters: re-point, never reprint."
    >
      <p>
        The QR Codes page creates and manages four kinds of code: <strong>URL</strong> (any link),{' '}
        <strong>Text</strong>, <strong>Wi-Fi</strong> (scan to join a network), and{' '}
        <strong>Contact card</strong> (vCard). The editor shows a live preview exactly as it will
        scan: pick foreground/background colours (with a contrast warning when a combination risks
        scan failures), size, error-correction level, and an optional centre logo.
      </p>
      <p>
        <strong>Naming a code.</strong> The <strong>Reference</strong> is how you find a code later
        and how the API and AI agents address it — it's prefilled from the code's own content (the
        Wi-Fi SSID, the URL's hostname, the contact's name, or the text content) and tidied to
        lowercase-with-hyphens automatically, so "Office WiFi" becomes{' '}
        <FactChip>office-wifi</FactChip>. It's fixed once the code is created. The{' '}
        <strong>Description</strong> and <strong>Tags</strong> are independent of the Reference —
        they're for finding and grouping codes in the list; neither is encoded into the QR, so you
        can reword them any time without reprinting. Hover the ⓘ beside any field for details.
      </p>
      <p>
        After saving, the new code appears on the first page when it matches your current domain and
        filters. If you are on a later page or have narrowed the search, return to the first page
        and check the filters to find it.
      </p>
      <p>
        <strong>Brand designs.</strong> The editor's <strong>Brand design</strong> selector applies
        your own presets in one click — the template ships neutral (black on white), and any presets
        you add to the registry appear here with <strong>Auto</strong> resolving the right design
        per domain. Tweaking any colour or logo flips the selector to <strong>Custom</strong>,
        keeping your edits. Wide wordmark logos automatically get a wider centre window so they stay
        legible.
      </p>
      <p>
        <strong>Wi-Fi security options.</strong> Choose the network <em>category</em>:{' '}
        <strong>Password-protected</strong> covers WPA, WPA2, and WPA3 alike (phones negotiate the
        best handshake from one universal code); <strong>Enterprise (802.1X)</strong> encodes
        login-based corporate networks — Android joins from the QR, iPhones must be configured
        manually; <strong>Open</strong> for password-less networks; and <strong>WEP</strong> only
        for legacy hardware.
      </p>
      <p>
        <strong>Dynamic QR — the key pattern.</strong> A URL code can be{' '}
        <strong>linked to a route</strong>, so the printed code encodes the short URL (e.g.{' '}
        <FactChip>links.example.com/menu</FactChip>) rather than the destination. When the
        destination changes, you just re-point the route — every poster, namecard, and slide printed
        with that QR keeps working. Re-point, never reprint. In the editor, switch on{' '}
        <strong>Link to a route</strong>, then pick an <strong>Existing route</strong> on the code's
        domain (the search ignores case and separators) or name a <strong>New route</strong> with
        its target: Bifrost creates it as a 302 redirect first, then saves the code. If the code
        cannot be saved, the route is kept and the next save reuses it. The editor notes when
        another code already links the same route, and flags dates and version words in a new
        route's name.
      </p>
      <p>
        <strong>Editing.</strong> Saving an edit sends only the fields you changed, so a code saved
        under older limits can still be edited; with nothing changed, nothing is sent. A code
        deleted elsewhere while you edit it closes the dialog with a note (and a route the edit just
        created for it is reported as kept, with View route). If a code cannot be saved after its
        new route was created, the message gives the reason, keeps the route and offers View route;
        save again once it is fixed. A row marked <strong>Unreadable record</strong> is a code
        stored in a shape that cannot be read: delete it and create it again.
      </p>
      <p>
        <strong>SVG or PNG?</strong> Both downloads scan identically — pick by where the QR is
        going. <strong>SVG</strong> is a vector: infinitely crisp at any size, so choose it for
        anything <em>printed or scaled</em> — posters, signage, namecards, packaging — and for
        design tools (Figma, Illustrator, InDesign). It is also the guaranteed-fidelity choice when
        the code carries a logo. <strong>PNG</strong> is a fixed-size image rendered at the QR's set
        pixel size — choose it for <em>digital embedding</em>: pasting into emails, chat,
        Word/Google Docs, and slides, which handle PNG far more reliably than SVG. Rule of thumb:
        printing or resizing → SVG; dropping into a document or email → PNG; unsure → SVG.
      </p>
      <p>
        You can also generate a quick QR for any existing route straight from the Routes page row
        menu — no saved record needed.
      </p>
      <Tip>
        QR images are served only through the API-key-authenticated admin API and dashboard (Wi-Fi
        codes can carry passwords, vCards carry contact details). If you need a stable public image
        URL — say, for an email signature — download the SVG and upload it to a public storage
        bucket, then serve it via a route.
      </Tip>
    </GuideSection>
  );
}
