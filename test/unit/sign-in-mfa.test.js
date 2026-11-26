/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/* global describe, it, beforeEach, afterEach */

const util = require('util');
const should = require('should');
const pryv = require('pryv');

const backup = require('../../src/main');
const lib = require('../../src/lib');
const { signInWithMfa, isMfaRequired, LOST_FACTOR_HINT } = require('../../src/lib/signInWithMfa');

/**
 * [SIMF] password sign-in with a multi-factor (MFA) step, against a fake
 * service (no network, no platform). Secret values below are unique strings
 * so the console capture and the error checks can tell none of them leaks.
 */

const PASSWORD = 'pw-secret-7f3a';
const MFA_TOKEN = 'mfa-token-secret-91c2';
const GOOD_CODE = '482913';
const BAD_CODE = '000111';
const SECRETS = [PASSWORD, MFA_TOKEN, GOOD_CODE, BAD_CODE];

function mfaRequiredError (method) {
  return new pryv.MfaRequiredError(MFA_TOKEN, { status: 200 }, { mfaToken: MFA_TOKEN, mfaMethod: method });
}

function apiError (id, message, status) {
  const err = new pryv.PryvError(message);
  err.id = id;
  err.status = status;
  return err;
}

function invalidCodeError () {
  return apiError('invalid-mfa-code', 'The MFA code is invalid', 400);
}

function assertNoSecret (err) {
  const shown = util.inspect(err) + '\n' + JSON.stringify(err) + '\n' + String(err && err.message);
  for (const secret of SECRETS) shown.should.not.containEql(secret);
}

/** Awaits a rejection, checks its id and that it carries no secret. */
async function rejects (promise, id) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  should.exist(caught, 'expected a rejection with id ' + id);
  should(caught.id).equal(id);
  assertNoSecret(caught);
  return caught;
}

/**
 * @param {Object} opts
 * @param {string|null|undefined} opts.mfaMethod - null: account without MFA
 * @param {Error} [opts.challengeError] - thrown by every mfaChallenge
 */
function fakeService (opts) {
  const calls = { login: [], challenge: [], verify: [] };
  const connection = { endpoint: 'https://token@user.example.com/', token: 'token' };
  const service = {
    calls,
    connection,
    async info () { return { register: 'https://reg.example.com/', api: 'https://{username}.example.com/' }; },
    async login (username, password, appId, origin) {
      calls.login.push({ username, password, appId, origin });
      if (password !== PASSWORD) throw apiError('invalid-credentials', 'Invalid credentials', 401);
      if (opts.mfaMethod === null) return connection;
      throw mfaRequiredError(opts.mfaMethod);
    },
    async mfaChallenge (username, mfaToken) {
      calls.challenge.push({ username, mfaToken });
      if (opts.challengeError) throw opts.challengeError;
    },
    async mfaVerify (username, mfaToken, code) {
      calls.verify.push({ username, mfaToken, code });
      if (mfaToken !== MFA_TOKEN || code !== GOOD_CODE) throw invalidCodeError();
      return connection;
    }
  };
  return service;
}

describe('[SIMF] sign-in with multi-factor authentication', function () {
  let printed;
  const saved = {};

  beforeEach(function () {
    printed = [];
    for (const name of ['log', 'info', 'warn', 'error']) {
      saved[name] = console[name];
      console[name] = (...args) => { printed.push(util.format(...args)); };
    }
  });

  afterEach(function () {
    for (const name of Object.keys(saved)) console[name] = saved[name];
    // Nothing secret ever reaches the console.
    const all = printed.join('\n');
    for (const secret of SECRETS) all.should.not.containEql(secret);
  });

  it('[SIM1] an account without MFA signs in as before', async function () {
    const service = fakeService({ mfaMethod: null });
    const conn = await backup.signInToPryv({ service, username: 'alice', password: PASSWORD });
    conn.should.equal(service.connection);
    service.calls.login.length.should.equal(1);
    service.calls.login[0].appId.should.equal('pryv-backup');
    service.calls.login[0].origin.should.equal('https://reg.example.com');
    service.calls.verify.length.should.equal(0);
  });

  it('[SIM2] a wrong password is rethrown unchanged', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    await rejects(signInWithMfa(service, 'alice', 'wrong', 'app', undefined, { mfaCode: GOOD_CODE }), 'invalid-credentials');
    service.calls.verify.length.should.equal(0);
  });

  it('[SIM3] TOTP: signs in with context.mfaCode', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    const conn = await backup.signInToPryv({ service, username: 'alice', password: PASSWORD, mfaCode: ' ' + GOOD_CODE + ' ' });
    conn.should.equal(service.connection);
    service.calls.verify.should.eql([{ username: 'alice', mfaToken: MFA_TOKEN, code: GOOD_CODE }]);
    service.calls.challenge.length.should.equal(0);
  });

  it('[SIM4] mfaCode is a single attempt: a wrong code fails', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    let asked = 0;
    await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      mfaCode: BAD_CODE,
      onMfaRequired: async () => { asked++; return GOOD_CODE; }
    }), 'invalid-mfa-code');
    service.calls.verify.length.should.equal(1);
    asked.should.equal(0);
  });

  it('[SIM5] SMS: onMfaRequired gets the method, resends, then a wrong code and a right one', async function () {
    const service = fakeService({ mfaMethod: 'sms' });
    const seen = [];
    const answers = [BAD_CODE, GOOD_CODE];
    const conn = await signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      onMfaRequired: async (args) => {
        seen.push({ method: args.method, attempt: args.attempt, maxAttempts: args.maxAttempts, previousError: args.previousError });
        if (args.attempt === 1) await args.resend();
        return answers.shift();
      }
    });
    conn.should.equal(service.connection);
    service.calls.challenge.should.eql([{ username: 'alice', mfaToken: MFA_TOKEN }]);
    service.calls.verify.map((c) => c.code).should.eql([BAD_CODE, GOOD_CODE]);
    seen.length.should.equal(2);
    seen[0].should.eql({ method: 'sms', attempt: 1, maxAttempts: 3, previousError: undefined });
    seen[1].method.should.equal('sms');
    seen[1].attempt.should.equal(2);
    seen[1].previousError.should.equal('The MFA code is invalid');
  });

  it('[SIM6] attempts are bounded: the last invalid-mfa-code error is thrown', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    let asked = 0;
    await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      onMfaRequired: async () => { asked++; return BAD_CODE; }
    }), 'invalid-mfa-code');
    asked.should.equal(3);
    service.calls.verify.length.should.equal(3);
  });

  it('[SIM7] maxAttempts can be set', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    let asked = 0;
    await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      maxAttempts: 1,
      onMfaRequired: async () => { asked++; return BAD_CODE; }
    }), 'invalid-mfa-code');
    asked.should.equal(1);
  });

  it('[SIM7B] a maxAttempts that is not a positive integer falls back to 3', async function () {
    for (const maxAttempts of [0, -1, 'x', 1.5, Infinity, null]) {
      const service = fakeService({ mfaMethod: 'totp' });
      let asked = 0;
      let seenMax;
      await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
        maxAttempts,
        onMfaRequired: async (args) => { asked++; seenMax = args.maxAttempts; return BAD_CODE; }
      }), 'invalid-mfa-code');
      asked.should.equal(3, 'maxAttempts ' + String(maxAttempts));
      seenMax.should.equal(3);
    }
  });

  it('[SIM8] an empty, null or undefined answer cancels the sign-in', async function () {
    for (const answer of ['  ', '', null, undefined]) {
      const service = fakeService({ mfaMethod: 'totp' });
      const err = await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
        onMfaRequired: async () => answer
      }), 'mfa-code-missing');
      should(err.mfaToken).equal(undefined);
      service.calls.verify.length.should.equal(0);
    }
  });

  it('[SIM8B] a blank mfaCode counts as absent', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    const conn = await signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      mfaCode: '   ',
      onMfaRequired: async () => GOOD_CODE
    });
    conn.should.equal(service.connection);
    service.calls.verify.map((c) => c.code).should.eql([GOOD_CODE]);
  });

  it('[SIM9] another verify error is not retried', async function () {
    const service = fakeService({ mfaMethod: 'sms' });
    service.mfaVerify = async () => { throw apiError('too-many-attempts', 'Too many attempts', 429); };
    let asked = 0;
    await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      onMfaRequired: async () => { asked++; return GOOD_CODE; }
    }), 'too-many-attempts');
    asked.should.equal(1);
  });

  it('[SIMA] no handler: the original MfaRequiredError is rethrown', async function () {
    const service = fakeService({ mfaMethod: 'totp' });
    const original = mfaRequiredError('totp');
    service.login = async () => { throw original; };
    const caught = await rejects(backup.signInToPryv({ service, username: 'alice', password: PASSWORD }), 'mfa-required');
    caught.should.equal(original);
    caught.mfaToken.should.equal(MFA_TOKEN);
    caught.method.should.equal('totp');
    service.calls.verify.length.should.equal(0);
  });

  it('[SIMD] no method (older core): passed on as undefined', async function () {
    const service = fakeService({ mfaMethod: undefined });
    let seen = 'unset';
    await signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, {
      onMfaRequired: async (args) => { seen = args.method; return GOOD_CODE; }
    });
    should(seen).equal(undefined);
  });

  describe('[SIMC] CLI prompt (scripts/mfa-prompt.js, scripts/prompt.js)', function () {
    const readPath = require.resolve('read');
    const promptPath = require.resolve('../../scripts/prompt');
    const mfaPromptPath = require.resolve('../../scripts/mfa-prompt');
    let savedRead;
    let savedIsTTY;
    let prompts;
    let answers;

    // The stub has the real module's shape: read 5 exports `{ read }`.
    function load () {
      savedRead = require.cache[readPath];
      require.cache[readPath] = {
        id: readPath,
        filename: readPath,
        loaded: true,
        exports: {
          read: async (opts) => {
            prompts.push(opts.prompt);
            if (answers.length === 0) return new Promise(() => {}); // input ended: never settles
            return answers.shift();
          }
        }
      };
      delete require.cache[promptPath];
      delete require.cache[mfaPromptPath];
      return { prompt: require(promptPath), mfaPrompt: require(mfaPromptPath) };
    }

    beforeEach(function () {
      prompts = [];
      savedIsTTY = process.stdin.isTTY;
      process.stdin.isTTY = true;
    });

    afterEach(function () {
      process.stdin.isTTY = savedIsTTY;
      if (savedRead) require.cache[readPath] = savedRead; else delete require.cache[readPath];
      delete require.cache[promptPath];
      delete require.cache[mfaPromptPath];
    });

    it('[SIC0] the real read module exports { read }', function () {
      const real = require('read');
      (typeof real.read).should.equal('function');
    });

    it('[SIC1] SMS: an empty line sends a new code, then the typed code signs in', async function () {
      answers = ['', BAD_CODE, GOOD_CODE];
      const { onMfaRequired } = load().mfaPrompt;
      const service = fakeService({ mfaMethod: 'sms' });
      const conn = await backup.signInToPryv({ service, username: 'alice', password: PASSWORD, onMfaRequired });
      conn.should.equal(service.connection);
      service.calls.challenge.length.should.equal(1);
      service.calls.verify.map((c) => c.code).should.eql([BAD_CODE, GOOD_CODE]);
      prompts.length.should.equal(3);
      prompts[0].should.match(/Code sent by SMS/);
      printed.join('\n').should.containEql(LOST_FACTOR_HINT);
      printed.join('\n').should.containEql('A new code was sent by SMS.');
      printed.join('\n').should.match(/attempt 2 of 3/);
    });

    it('[SIC2] TOTP: asks for the authenticator code; an empty line cancels', async function () {
      answers = [''];
      const { onMfaRequired } = load().mfaPrompt;
      const service = fakeService({ mfaMethod: 'totp' });
      await rejects(signInWithMfa(service, 'alice', PASSWORD, 'restore-bkp', undefined, { onMfaRequired }), 'mfa-code-missing');
      prompts.should.eql(['Code from your authenticator app (leave empty to cancel): ']);
      service.calls.challenge.length.should.equal(0);
    });

    it('[SIC3] no method (older core): SMS wording and resend', async function () {
      answers = ['', GOOD_CODE];
      const { onMfaRequired } = load().mfaPrompt;
      const service = fakeService({ mfaMethod: undefined });
      await signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, { onMfaRequired });
      prompts[0].should.match(/Code sent by SMS/);
      service.calls.challenge.length.should.equal(1);
    });

    it('[SIC4] a refused resend is reported and the prompt stays', async function () {
      answers = ['', GOOD_CODE];
      const { onMfaRequired } = load().mfaPrompt;
      const service = fakeService({
        mfaMethod: 'sms',
        challengeError: apiError('too-many-attempts', 'Wait 30 seconds before asking for a new code', 429)
      });
      const conn = await signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, { onMfaRequired });
      conn.should.equal(service.connection);
      printed.join('\n').should.containEql('Could not send a new code: Wait 30 seconds before asking for a new code');
      printed.join('\n').should.not.containEql('A new code was sent by SMS.');
      prompts.length.should.equal(2);
    });

    it('[SIC5] at most 3 resends per sign-in, then an empty line cancels', async function () {
      answers = ['', '', BAD_CODE, '', ''];
      const { onMfaRequired, MAX_RESENDS } = load().mfaPrompt;
      MAX_RESENDS.should.equal(3);
      const service = fakeService({ mfaMethod: 'sms' });
      await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, { onMfaRequired }), 'mfa-code-missing');
      service.calls.challenge.length.should.equal(3);
      prompts.length.should.equal(5);
      printed.join('\n').should.containEql('3 new codes were already requested: sign-in cancelled.');
    });

    it('[SIC6] without a terminal the MFA step fails clearly, before any prompt', async function () {
      answers = [GOOD_CODE];
      const { onMfaRequired } = load().mfaPrompt;
      process.stdin.isTTY = undefined;
      const service = fakeService({ mfaMethod: 'sms' });
      const err = await rejects(signInWithMfa(service, 'alice', PASSWORD, 'app', undefined, { onMfaRequired }), 'mfa-needs-terminal');
      err.message.should.match(/run the script in a terminal/);
      prompts.length.should.equal(0);
      service.calls.verify.length.should.equal(0);
    });

    it('[SIC7] a prompt whose input ended is rejected with end-of-input', async function () {
      answers = [];
      const { ask, failPendingPrompt, describeFailure } = load().prompt;
      const pending = ask({ prompt: 'Username : ' });
      failPendingPrompt().should.equal(true);
      const err = await rejects(pending, 'end-of-input');
      err.message.should.equal('Input ended before an answer to "Username :": run the script in a terminal and type the answers.');
      describeFailure(err).should.equal(err.message);
      failPendingPrompt().should.equal(false);
      const other = new Error('boom');
      describeFailure(other).should.equal(other);
    });

    it('[SIC8] an answered prompt is not pending any more', async function () {
      answers = ['alice'];
      const { ask, failPendingPrompt } = load().prompt;
      (await ask({ prompt: 'Username : ' })).should.equal('alice');
      failPendingPrompt().should.equal(false);
    });
  });

  it('[SIMB] isMfaRequired matches by name, and the helpers are exported', function () {
    isMfaRequired(mfaRequiredError('sms')).should.equal(true);
    isMfaRequired(new Error('x')).should.equal(false);
    isMfaRequired(null).should.equal(false);
    lib.signInWithMfa.should.equal(signInWithMfa);
    backup.signInWithMfa.should.equal(signInWithMfa);
    backup.LOST_FACTOR_HINT.should.equal(LOST_FACTOR_HINT);
    LOST_FACTOR_HINT.should.match(/turns multi-factor authentication off/);
  });
});
