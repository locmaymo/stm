import js from '@eslint/js';
import { globalIgnores } from 'eslint/config';

export default [
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/.tmp/**',
    'docs/**',
  ]),
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  js.configs.recommended,
  {
    // Everything under the site's `public` is served as written and runs in the
    // browser, not in Node: the OAuth relay, the theme bootstrap, the switches.
    files: ['apps/site/public/**/*.js'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        URLSearchParams: 'readonly',
        atob: 'readonly',
        document: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    // The site builder runs in Node and writes files. `ecmaVersion: 'latest'`
    // because it reads the legal texts with an import attribute, which the
    // 2022 grammar the rest of this config uses cannot parse.
    files: ['apps/site/**/*.mjs'],
    ignores: ['apps/site/public/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { URL: 'readonly' },
    },
  },
  {
    // The Windows launcher has to be CommonJS: Node runs a single-executable
    // entry point as CommonJS, so an ES module entry never gets as far as
    // running at all.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        AbortSignal: 'readonly',
        __dirname: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        module: 'writable',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
];
