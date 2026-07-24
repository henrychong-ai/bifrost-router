import { Link } from 'react-router-dom';
import { getModifierKey } from '@/hooks';
import { GUIDE_SECTIONS } from '../guide-registry';
import { GuideSection, Shortcut, Tip } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'feedback-and-help')!;

export function FeedbackAndHelpSection() {
  const mod = getModifierKey();
  return (
    <GuideSection
      meta={meta}
      description="Found a bug or want a feature? Report it in-app — it goes straight into a triaged work queue."
    >
      <p>
        The <strong>Feedback</strong> button in the header (or{' '}
        <Shortcut keys={[mod, '/']} label="from anywhere" />) opens the report dialog: pick a type
        (bug, feature, question), describe it, and optionally attach up to three screenshots. Bug
        reports automatically include a technical capture (recent console and network activity, with
        credentials scrubbed) so the fix does not start with "can you reproduce it?".
      </p>
      <p>
        Track your submissions on the Feedback page under <strong>My feedback</strong> — each moves
        through a visible lifecycle (new → triaged → in progress → resolved). Administrators (and
        the AI agents working the queue) see, prioritise, and action every report.
      </p>
      <p>
        Wondering what changed since you last logged in? The{' '}
        <Link
          to="/changelog"
          className="
            font-medium text-blue-600 transition-colors
            hover:text-blue-800
          "
        >
          Changelog
        </Link>{' '}
        lists every release with searchable notes — the version number in the bottom-left corner of
        the sidebar takes you there too.
      </p>
      <Tip>
        The more specific the report, the faster the turnaround: the exact link or file, what you
        expected, and what happened instead. Screenshots beat descriptions.
      </Tip>
    </GuideSection>
  );
}
