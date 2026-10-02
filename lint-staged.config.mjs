// lint-staged.config.mjs: Oxlint + Biome stack (team template, the globs this repo uses).
// .mjs so the ESM export works whatever package.json "type" says.

export default {
  // TypeScript / JavaScript: lint, then format + sort imports. A staged file
  // that .oxlintrc.json ignores (this file, *.config.js) leaves Oxlint nothing
  // to lint, which is not a failure.
  '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}': [
    'oxlint --fix --max-warnings=0 --no-error-on-unmatched-pattern',
    'biome check --write --no-errors-on-unmatched',
  ],

  // CSS and JSON. Keep Markdown, YAML and HTML out of Biome globs: Biome does not
  // format them yet (HTML only behind an opt-in), and a file Biome skips fails the hook.
  '*.{css,json,jsonc}': ['biome check --write --no-errors-on-unmatched'],
};
