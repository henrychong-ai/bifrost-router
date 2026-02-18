// Residual ESLint — only for plugins Oxlint doesn't support natively.
// Oxlint handles all core, TypeScript, React hooks, and other linting.
// eslint-plugin-oxlint disables all rules that Oxlint already covers.
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import oxlint from 'eslint-plugin-oxlint';

export default [
  { ignores: ['dist'] },

  // React Refresh (Vite HMR support — not in Oxlint)
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Relaxed rules for shadcn/ui components (generated code)
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // eslint-plugin-oxlint MUST be last — disables rules Oxlint already covers
  ...oxlint.buildFromOxlintConfigFile('../oxlint.json'),
];
