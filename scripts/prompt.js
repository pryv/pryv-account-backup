/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * Terminal prompt shared by the CLI scripts.
 *
 * `ask(opts)` is `read(opts)` (the `read` package) with one addition: when the
 * input ends before an answer (end of a pipe, Ctrl-D in a terminal), `read`
 * never settles and Node would exit with code 0 and no output. The pending
 * prompt is then rejected with an `end-of-input` error instead, so the script
 * reports it and exits non-zero.
 */
const { read } = require('read');

let pending = null;
let listening = false;

function endOfInputError (prompt) {
  const err = new Error('Input ended before an answer to "' + String(prompt || '').trim() +
    '": run the script in a terminal and type the answers.');
  err.id = 'end-of-input';
  return err;
}

/**
 * Rejects the prompt still waiting for an answer, if any. Called when Node is
 * about to exit (nothing else left to do), which only happens while a prompt
 * waits if its input has ended.
 * @returns {boolean} whether a prompt was waiting
 */
function failPendingPrompt () {
  if (!pending) return false;
  const p = pending;
  pending = null;
  p.reject(endOfInputError(p.prompt));
  return true;
}

function ask (opts) {
  if (!listening) {
    listening = true;
    process.on('beforeExit', failPendingPrompt);
  }
  return new Promise((resolve, reject) => {
    const entry = { prompt: opts.prompt, reject };
    pending = entry;
    read(opts).then((value) => {
      if (pending === entry) pending = null;
      resolve(value);
    }, (err) => {
      if (pending === entry) pending = null;
      reject(err);
    });
  });
}

// Errors raised by the scripts' own prompts: their message says it all.
const PROMPT_ERROR_IDS = ['end-of-input', 'mfa-needs-terminal', 'mfa-code-missing'];

/**
 * The message to print for a failed run: the message alone for a prompt
 * error (input ended, no terminal, sign-in cancelled), the full error otherwise.
 */
function describeFailure (err) {
  return (err && PROMPT_ERROR_IDS.includes(err.id)) ? err.message : err;
}

module.exports = { ask, failPendingPrompt, describeFailure };
