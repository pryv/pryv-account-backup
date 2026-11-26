/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/* global describe, it, before, after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
require('should');

/**
 * [CLIS] the backup and restore scripts as a person runs them, in a child
 * process, against a fake platform on the loopback interface (no real
 * platform). Answers are written when their prompt appears. The child's
 * stdin is a pipe, not a terminal.
 */

const ROOT = path.resolve(__dirname, '../..');
const PASSWORD = 'pw-secret-cli-5d1e';
const MFA_TOKEN = 'mfa-token-secret-cli-77a0';

function startFakePlatform () {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const port = server.address().port;
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/service/info') {
        return json(200, {
          name: 'Fake',
          register: 'http://127.0.0.1:' + port + '/reg/',
          access: 'http://127.0.0.1:' + port + '/access/',
          api: 'http://127.0.0.1:' + port + '/{username}/'
        });
      }
      if (req.url === '/alice/auth/login') {
        const sent = JSON.parse(body || '{}');
        if (sent.password !== PASSWORD) {
          return json(401, { error: { id: 'invalid-credentials', message: 'The given username/password pair is invalid.' } });
        }
        return json(200, { mfaToken: MFA_TOKEN, mfaMethod: 'sms' });
      }
      if (req.url === '/bob/auth/login') return json(200, { token: 'bob-personal-token' });
      json(404, { error: { id: 'unknown-resource', message: 'Not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * @param {string[]} args - script and its arguments
 * @param {Array<[string, string]>} answers - [prompt text, answer]; the input
 *   is closed once they are all given
 */
function runScript (args, answers) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    delete env.PRYV_BACKUP_TEST_USERNAME;
    delete env.PRYV_BACKUP_TEST_PASSWORD;
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let seen = 0;
    const queue = answers.slice();
    const onOutput = (chunk) => {
      out += chunk.toString();
      while (queue.length > 0) {
        const at = out.indexOf(queue[0][0], seen);
        if (at < 0) break;
        seen = at + queue[0][0].length;
        child.stdin.write(queue.shift()[1] + '\n');
      }
      if (queue.length === 0 && !child.stdin.writableEnded) child.stdin.end();
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    if (queue.length === 0) child.stdin.end();
    const timer = setTimeout(() => { child.kill(); reject(new Error('script timed out; output:\n' + out)); }, 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function count (text, part) {
  return text.split(part).length - 1;
}

describe('[CLIS] CLI scripts in a child process', function () {
  this.timeout(20000);
  let server;
  let url;
  let restoreDir;

  before(async function () {
    server = await startFakePlatform();
    url = 'http://127.0.0.1:' + server.address().port + '/service/info';
    restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clis-restore-'));
    fs.writeFileSync(path.join(restoreDir, 'events.json'), '{"events":[]}');
  });

  after(function () {
    if (server) server.close();
    if (restoreDir) fs.rmSync(restoreDir, { recursive: true, force: true });
    // The folder [CLS6] makes in the (git-ignored) backup/ directory.
    fs.rmSync(path.join(ROOT, 'backup', '127.0.0.1_bob_'), { recursive: true, force: true });
  });

  function backupAnswers (password, username) {
    return [
      ['Service info URL:', url],
      ['Username :', username || 'alice'],
      ['Password :', password],
      ['Also fetch trashed data?', 'n'],
      ['Also fetch attachment files?', 'n'],
      ['Also fetch per-access version history?', 'n'],
      ['Events chunk size in months', '1']
    ];
  }

  it('[CLS1] backup: input that ends at a prompt fails with a message and a non-zero exit', async function () {
    const { code, out } = await runScript(['scripts/start-backup.js'], []);
    code.should.not.equal(0);
    out.should.containEql('Input ended before an answer to "Service info URL:"');
    count(out, 'Failed in process with error').should.equal(1);
    out.should.not.match(/\n\s+at /); // the message alone, no stack trace
  });

  it('[CLS2] restore: input that ends at a prompt fails with a message and a non-zero exit', async function () {
    const { code, out } = await runScript(['scripts/start-restore.js', restoreDir], [['Service info URL:', url]]);
    code.should.not.equal(0);
    out.should.containEql('Input ended before an answer to "Username :"');
  });

  it('[CLS3] backup: a failed sign-in is printed once', async function () {
    const { code, out } = await runScript(['scripts/start-backup.js'], backupAnswers('wrong-password'));
    code.should.not.equal(0);
    count(out, 'The given username/password pair is invalid.').should.equal(1);
    out.should.not.containEql('Connection failed with Error');
  });

  it('[CLS6] backup: a failed run (after sign-in) is printed once', async function () {
    const { code, out } = await runScript(['scripts/start-backup.js'], backupAnswers('any', 'bob'));
    code.should.not.equal(0);
    out.should.containEql('Starting Backup');
    count(out, 'Failed in process with error').should.equal(1);
  });

  it('[CLS4] backup: the MFA step is reached and, without a terminal, fails clearly', async function () {
    const { code, out } = await runScript(['scripts/start-backup.js'], backupAnswers(PASSWORD));
    code.should.not.equal(0);
    out.should.containEql('This account uses multi-factor authentication: run the script in a terminal to type the code');
    out.should.not.containEql('MfaRequiredError');
    out.should.not.containEql(PASSWORD);
    out.should.not.containEql(MFA_TOKEN);
  });

  it('[CLS5] restore: the MFA step is reached and, without a terminal, fails clearly', async function () {
    const { code, out } = await runScript(['scripts/start-restore.js', restoreDir], [
      ['Service info URL:', url],
      ['Username :', 'alice'],
      ['Password :', PASSWORD]
    ]);
    code.should.not.equal(0);
    out.should.containEql('This account uses multi-factor authentication: run the script in a terminal to type the code');
    out.should.not.containEql('MfaRequiredError');
    out.should.not.containEql(MFA_TOKEN);
  });
});
