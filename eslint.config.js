/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * ESLint flat config using neostandard (StandardJS with semicolons).
 * The per-method modules run in Node and in the browser, so both global sets
 * are declared.
 */
const neostandard = require('neostandard');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'backup/**',
      'out/**'
    ]
  },

  ...neostandard({ semi: true, noStyle: false }),

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.mocha
      }
    }
  },

  // Test files: should.js assertions read as bare expressions.
  {
    files: ['test/**/*.js'],
    rules: {
      'no-unused-expressions': 'off'
    }
  }
];
