import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// Globs avoid brace patterns (e.g. `*.{js,jsx}`) because the project pins
// brace-expansion@5 via overrides, which breaks ESLint's bundled minimatch.

const lenientRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-useless-escape': 'off',
  'no-control-regex': 'off',
};

const reactRules = {
  ...lenientRules,
  'react/jsx-uses-react': 'off',
  'react/react-in-jsx-scope': 'off',
  'react/prop-types': 'off',
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
};

// Files that run Playwright in Node AND pass callbacks into `page.evaluate()`
// where browser globals are valid. We grant both global sets so we don't have
// to riddle the source with eslint-disable comments.
const playwrightHosts = [
  'src/scrapers/starttest_scraper.js',
  'src/scrapers/ttp_scraper.js',
  'src/scraper-runner.js',
  'scripts/snap-starttest.js',
  'scripts/inspect-gmat-cdp.js',
  'scripts/probe_user_pick.js',
  'scripts/probe_difficulty.mjs',
  'scripts/gc-rc-parser-test.mjs',
];

// Page-level globals injected by the StartTest harness on the question pages
const starttestGlobals = {
  jsondata_reviewtable: 'readonly',
  vItemInformation: 'readonly',
  processAction: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'client/dist/**',
      'data/**',
      'tmp/**',
      '.claude/**',
      'scripts/parse-lsat-pdf.js',
    ],
  },

  js.configs.recommended,

  // Backend (CommonJS Node)
  {
    files: ['src/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: lenientRules,
  },

  // Browser-injected scrapers run entirely in page context
  {
    files: [
      'src/scrapers/gmat_scraper.js',
      'src/scrapers/gmat_club_scraper.js',
      'src/scrapers/gmat_club_question_scraper.js',
      'public/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, module: 'readonly' },
    },
    rules: lenientRules,
  },

  // Node files that also embed browser-side callbacks via page.evaluate()
  {
    files: playwrightHosts,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...starttestGlobals,
      },
    },
    rules: lenientRules,
  },

  // Root config files (tailwind, postcss) — CJS
  {
    files: ['*.config.js', '*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: lenientRules,
  },

  // ESM scripts
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...starttestGlobals },
    },
    rules: lenientRules,
  },

  // Vite config (Node ESM)
  {
    files: ['client/vite.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: lenientRules,
  },

  // Frontend JS
  {
    files: ['client/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: reactRules,
  },

  // Frontend JSX
  {
    files: ['client/src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: reactRules,
  },
];
