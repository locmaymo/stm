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
    // The OAuth relay is a static page served from the project's domain and
    // runs in the browser, not in Node.
    files: ['deploy/oauth-relay/public/**/*.js'],
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
