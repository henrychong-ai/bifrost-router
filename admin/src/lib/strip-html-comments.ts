/**
 * Strip HTML comments from the built `index.html`.
 *
 * `admin/index.html` carries maintainer rationale in comments — genuinely
 * valuable documentation that STAYS IN SOURCE. This transform removes it only
 * from the shipped artefact, which would otherwise serve internal architecture
 * notes to every visitor.
 *
 * Deliberately a build-time strip rather than deleting the comments: losing
 * hard-won rationale to satisfy a scanner would be the wrong trade.
 * Conditional comments (`<!--[if`) and the SSR/hydration marker form (`<!--[`)
 * are preserved in case they are ever introduced.
 *
 * LIMITATION: the regex is not HTML-context-aware. An inline `<script>` or
 * `<style>` whose CONTENT contains the literal `<!--` (a legacy script-hiding
 * wrapper, or a JS string) would have everything up to the next `-->` removed,
 * corrupting the block. `index.html` has no inline script or style today, so
 * this is safe — but add one and this transform needs a real parser first.
 *
 * TWO WAYS A SINGLE PASS LETS A COMMENT THROUGH, both closed here:
 *   - Removing one comment can join the text on either side of it into a new
 *     one (`<!-` + `-` around an inner comment). The replacement therefore
 *     repeats until the string stops changing; each pass that changes anything
 *     shortens it, so the loop ends.
 *   - A comment that is never closed matches nothing and would ship whole, with
 *     the rest of the document inside it. That is refused: the build fails
 *     rather than publish the note.
 */
const HTML_COMMENT = /<!--(?!\[)[\s\S]*?-->/g;
const HTML_COMMENT_OPENER = /<!--(?!\[)/;

export function stripHtmlCommentsFromHtml(html: string): string {
  let current = html;
  let previous: string;
  do {
    previous = current;
    current = current.replace(HTML_COMMENT, '');
  } while (current !== previous);

  if (HTML_COMMENT_OPENER.test(current)) {
    throw new Error(
      'strip-html-comments: unterminated HTML comment in index.html (an opener with no closing marker)',
    );
  }
  return current;
}

/** Vite plugin wrapper — applied on build only, after every other transform. */
export function stripHtmlComments() {
  return {
    name: 'strip-html-comments',
    enforce: 'post' as const,
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return stripHtmlCommentsFromHtml(html);
    },
  };
}
