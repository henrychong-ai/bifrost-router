import { getModifierKey } from '@/hooks';
import { GuideSection, Shortcut, Tip } from '../guide-primitives';
import { GUIDE_SECTIONS } from '../guide-registry';

const meta = GUIDE_SECTIONS.find(s => s.id === 'power-tools')!;

export function PowerToolsSection() {
  const mod = getModifierKey();
  return (
    <GuideSection
      meta={meta}
      description="The fastest ways around the dashboard once you know where things are."
    >
      <p>
        The <strong>command palette</strong> is the universal entry point: jump to any page, trigger
        actions like Create New Route, and — most usefully —{' '}
        <strong>search every route across all your domains</strong> by path, target, type, status
        code, domain, bucket or host header, from anywhere in the app.
      </p>
      <p>
        Search ignores letter case and separators (spaces, hyphens, underscores, dots and slashes),
        accepts words in any order, and lists the closest path matches first, so “summer sale” finds
        /summer-sale; other text, such as accents and the domain, matches as typed. The Routes page,
        the QR code list and the QR editor's route picker search the same way.
      </p>
      <div className="space-y-2">
        <p className="font-medium text-blue-950">Keyboard shortcuts:</p>
        <ul className="space-y-1.5">
          <li>
            <Shortcut keys={[mod, 'K']} label="Open the command palette (anywhere)" />
          </li>
          <li>
            <Shortcut keys={['n']} label="New route (on the Routes page)" />
          </li>
          <li>
            <Shortcut keys={['/']} label="Focus the search field (on the Routes page)" />
          </li>
          <li>
            <Shortcut keys={['e']} label="Edit the selected route (on the Routes page)" />
          </li>
          <li>
            <Shortcut keys={[mod, '/']} label="Send feedback (anywhere)" />
          </li>
        </ul>
      </div>
      <p>
        Everything cross-links: a file's detail dialog jumps to the routes serving it, audit entries
        jump to the route or file they touched, and route targets show live link previews so you can
        verify a destination without leaving the page.
      </p>
      <Tip>
        Table page sizes (50/100/250) persist per browser — set it once on any list page and every
        table remembers.
      </Tip>
    </GuideSection>
  );
}
