/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * ESLint flat config using neostandard (StandardJS with semicolons).
 * Node globals everywhere; browser globals only where the isomorphic modules
 * live (and in tests, which exercise them); mocha globals only in tests.
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
        ...globals.node
      }
    }
  },

  {
    files: ['src/methods/**/*.js', 'src/lib/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // Test files: should.js assertions read as bare expressions.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.mocha
      }
    },
    rules: {
      'no-unused-expressions': 'off'
    }
  }
];
