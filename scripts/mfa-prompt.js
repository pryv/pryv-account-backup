/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * Terminal prompt for the multi-factor (MFA) step of the CLI sign-in: the
 * `onMfaRequired` handler given to `signInWithMfa` / `signInToPryv`.
 *
 * - `totp`: asks for the code from the authenticator app; an empty line cancels;
 * - `sms` (or no method, as older cores only offered SMS): asks for the code
 *   sent by SMS; an empty line asks the platform for a new code, at most
 *   `MAX_RESENDS` times (the next empty line cancels). A refused request (the
 *   platform allows one SMS per 30 seconds) is reported and the prompt stays.
 * - any other method: asks for the verification code; an empty line cancels.
 *
 * The code must be typed in a terminal: without one (input from a pipe), the
 * step fails with `mfa-needs-terminal`. The code is passed on; it is never
 * written to the console output or to a log.
 */
const { ask } = require('./prompt');
const { LOST_FACTOR_HINT } = require('../src/lib/signInWithMfa');

const MAX_RESENDS = 3;
const resendCounts = new WeakMap();

function isSms (method) {
  return method === 'sms' || method == null;
}

function promptFor (method) {
  if (method === 'totp') return 'Code from your authenticator app (leave empty to cancel): ';
  if (isSms(method)) {
    return 'Code sent by SMS (leave empty to send a new one, up to ' + MAX_RESENDS +
      ' times; Ctrl-C to cancel): ';
  }
  return 'Verification code (leave empty to cancel): ';
}

function needsTerminalError () {
  const err = new Error('This account uses multi-factor authentication: run the script in a ' +
    'terminal to type the code (library callers can pass mfaCode or onMfaRequired).');
  err.id = 'mfa-needs-terminal';
  return err;
}

async function onMfaRequired ({ method, resend, attempt, maxAttempts, previousError }) {
  if (!process.stdin.isTTY) throw needsTerminalError();
  if (attempt === 1) {
    if (method === 'totp') {
      console.log('This account uses multi-factor authentication (authenticator app).');
    } else if (isSms(method)) {
      console.log('This account uses multi-factor authentication: a code was sent by SMS.');
    } else {
      console.log('This account uses multi-factor authentication.');
    }
    console.log(LOST_FACTOR_HINT);
  } else {
    console.log('Code not accepted (' + previousError + '), attempt ' + attempt + ' of ' + maxAttempts + '.');
  }
  for (;;) {
    const answer = await ask({ prompt: promptFor(method), silent: false });
    const code = (answer || '').trim();
    if (code !== '' || !isSms(method)) return code;
    // Counted per sign-in (one `resend` function per sign-in), across attempts.
    const resends = resendCounts.get(resend) || 0;
    if (resends >= MAX_RESENDS) {
      console.log(MAX_RESENDS + ' new codes were already requested: sign-in cancelled.');
      return '';
    }
    resendCounts.set(resend, resends + 1);
    try {
      await resend();
      console.log('A new code was sent by SMS.');
    } catch (err) {
      console.log('Could not send a new code: ' + ((err && err.message) || err));
    }
  }
}

module.exports = { onMfaRequired, MAX_RESENDS };
