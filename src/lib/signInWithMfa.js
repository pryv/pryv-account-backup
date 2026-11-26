/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * Password sign-in that completes a multi-factor (MFA) challenge.
 *
 * `service.login` throws an `MfaRequiredError` when the account has MFA
 * active (lib-js `pryv` 3.20+). This helper finishes that sign-in with a
 * one-time code from the second factor (`totp`: an authenticator app;
 * `sms`: a code sent by SMS when the login is made):
 *
 *   - `handlers.mfaCode` (string): one attempt with that code (a blank string
 *     counts as absent and falls through to the next option);
 *   - else `handlers.onMfaRequired({ method, resend, attempt, maxAttempts,
 *     previousError })` (async, returns the code): asked again after a wrong
 *     code (`invalid-mfa-code`), up to `maxAttempts` (a positive integer,
 *     default 3) times; an empty answer cancels (`mfa-code-missing`).
 *     `resend()` asks the platform to send a new SMS code (the platform allows
 *     one per 30 seconds and refuses others with `too-many-attempts`). The
 *     platform also caps attempts per sign-in (5 by default), then ends the
 *     sign-in with `invalid-access-token`; any error other than a wrong code
 *     is thrown at once;
 *   - else the original `MfaRequiredError` is rethrown unchanged.
 *
 * Recovery codes are deliberately not a sign-in path: on the platform a
 * recovery code turns MFA off on the account. A person who lost their second
 * factor goes through the account's own recovery (see `LOST_FACTOR_HINT`).
 *
 * Nothing secret is logged: not the password, the code or the MFA token.
 * Browser-isomorphic (no Node-only API).
 */

const DEFAULT_MAX_ATTEMPTS = 3;

const LOST_FACTOR_HINT = 'Lost your second factor? Recovery codes are not accepted here: use ' +
  'the recovery in your account app, which turns multi-factor authentication off on the ' +
  'account, then sign in again.';

/**
 * @param {Error} err
 * @returns {boolean} whether `err` is lib-js's `MfaRequiredError` (checked by
 *   name, so a second copy of the `pryv` package in a bundle still matches)
 */
function isMfaRequired (err) {
  return !!err && err.name === 'MfaRequiredError' && typeof err.mfaToken === 'string';
}

/**
 * @param {pryv.Service} service
 * @param {string} username
 * @param {string} password
 * @param {string} appId
 * @param {string} [origin] Node only (see `Service.login`)
 * @param {Object} [handlers]
 * @param {string} [handlers.mfaCode]
 * @param {function(Object): Promise<string>} [handlers.onMfaRequired]
 * @param {number} [handlers.maxAttempts=3] positive integer, else 3
 * @returns {Promise<pryv.Connection>}
 */
async function signInWithMfa (service, username, password, appId, origin, handlers) {
  try {
    return await service.login(username, password, appId, origin);
  } catch (err) {
    if (!isMfaRequired(err)) throw err;
    return await completeMfa(service, username, err, handlers || {});
  }
}

async function completeMfa (service, username, mfaErr, handlers) {
  const mfaToken = mfaErr.mfaToken;
  const method = mfaErr.method;

  if (handlers.mfaCode != null && String(handlers.mfaCode).trim() !== '') {
    return await service.mfaVerify(username, mfaToken, String(handlers.mfaCode).trim());
  }
  if (typeof handlers.onMfaRequired !== 'function') throw mfaErr;

  const maxAttempts = (Number.isInteger(handlers.maxAttempts) && handlers.maxAttempts > 0)
    ? handlers.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const resend = () => service.mfaChallenge(username, mfaToken);
  let previousError;
  for (let attempt = 1; ; attempt++) {
    const code = await handlers.onMfaRequired({ method, resend, attempt, maxAttempts, previousError });
    if (code == null || String(code).trim() === '') {
      const err = new Error('Sign-in cancelled: no multi-factor authentication code was given.');
      err.id = 'mfa-code-missing';
      throw err;
    }
    try {
      return await service.mfaVerify(username, mfaToken, String(code).trim());
    } catch (err) {
      if (err && err.id === 'invalid-mfa-code' && attempt < maxAttempts) {
        previousError = err.message || 'invalid code';
        continue;
      }
      throw err;
    }
  }
}

module.exports = {
  signInWithMfa,
  isMfaRequired,
  LOST_FACTOR_HINT
};
