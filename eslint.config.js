'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

// Flat config. The project mixes three execution contexts, each with a
// different set of available globals, so we scope rules by path.
module.exports = [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', 'dist/**', 'build/icon.iconset/**'],
  },

  // Main + preload run in the Electron/Node main process (CommonJS).
  {
    files: ['main.js', 'preload.js', 'logger.js', 'eslint.config.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Renderer runs in a sandboxed browser context — no Node.
  {
    files: ['renderer/app.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, WorkRadarDomain: 'readonly' },
    },
  },

  // domain.js is dual-mode: it must run as a browser global AND as a
  // CommonJS module under node:test, so it sees both global sets.
  {
    files: ['renderer/domain.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // Tests use Node's built-in test runner.
  {
    files: ['test/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  prettier,
];
