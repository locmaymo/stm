import js from '@eslint/js';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'docs/**',
    ],
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
];
