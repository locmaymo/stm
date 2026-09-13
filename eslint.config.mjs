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
