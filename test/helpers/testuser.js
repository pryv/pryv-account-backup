/**
 * Live test account, read from the environment.
 *
 * The acceptance tests (and the unit tests that talk to a real Pryv platform)
 * need an existing account. No credentials are committed in this repository:
 * set the variables below to run them, otherwise those suites are skipped.
 *
 *   PRYV_BACKUP_TEST_USERNAME          username of the test account (required)
 *   PRYV_BACKUP_TEST_PASSWORD          password of the test account (required)
 *   PRYV_BACKUP_TEST_SERVICE_INFO_URL  service info URL
 *                                      (default: https://reg.pryv.me/service/info)
 */

const ENV_HINT = 'set PRYV_BACKUP_TEST_USERNAME and PRYV_BACKUP_TEST_PASSWORD ' +
  '(optionally PRYV_BACKUP_TEST_SERVICE_INFO_URL) to run them';

const username = process.env.PRYV_BACKUP_TEST_USERNAME;
const password = process.env.PRYV_BACKUP_TEST_PASSWORD;

const credentials = (username && password)
  ? {
      serviceInfoUrl: process.env.PRYV_BACKUP_TEST_SERVICE_INFO_URL || 'https://reg.pryv.me/service/info',
      username,
      password
    }
  : null;

const notified = new Set();

/**
 * To call from a suite's `before` hook (with `this` bound to the hook context):
 * skips the suite when no live account is configured, printing one notice.
 * @param {Object} ctx - the mocha hook context (`this`)
 * @param {string} suiteName
 * @returns {boolean} true when the suite may run
 */
function requireLiveAccount (ctx, suiteName) {
  if (credentials) return true;
  if (!notified.has(suiteName)) {
    notified.add(suiteName);
    console.log('      [skipped] "' + suiteName + '" needs a live Pryv account: ' + ENV_HINT + '.');
  }
  ctx.skip();
  return false;
}

module.exports = { credentials, requireLiveAccount, ENV_HINT };
