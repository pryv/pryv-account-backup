/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
const fs = require('fs');
const path = require('path');
const async = require('async');
const read = require('read');
const pryv = require('pryv');
const restore = require('../src/restore.js');
const context = {};

// read v5+ returns a Promise instead of taking a callback. Wrap so the existing
// async.series chain stays intact without rewriting the script.
function readP (opts, callback) {
  read(opts).then((value) => callback(null, value)).catch(callback);
}

// Accept either legacy single-file events.json (older backups) or any chunked
// events-YYYY-MM.json (0.5.0+) as evidence that the directory is a valid
// backup source.
function backupHasEvents (dir) {
  if (fs.existsSync(path.join(dir, 'events.json'))) return true;
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((n) => n.startsWith('events-') && n.endsWith('.json'));
}

const USAGE = 'Usage: node scripts/start-restore.js <pathToDirectory> [--restore-secondary-emails]';
// Re-adding the backup's non-primary addresses sends each a verification mail
// from the target platform, so it is opt-in.
const KNOWN_OPTIONS = ['--restore-secondary-emails'];

const args = process.argv.slice(2);
const unknownOptions = args.filter((a) => a.startsWith('--') && !KNOWN_OPTIONS.includes(a));
if (unknownOptions.length > 0) {
  console.log('Unknown option(s): ' + unknownOptions.join(' '));
  console.log(USAGE);
  process.exit(2);
}
const sourceArg = args.find((a) => !a.startsWith('--'));
context.options = {
  restoreSecondaryEmails: args.includes('--restore-secondary-emails')
};

if (!sourceArg) {
  console.log(USAGE);
  process.exit(0);
}
if (!backupHasEvents(sourceArg)) {
  console.log('Directory [' + sourceArg + '] is not a valid backup directory ' +
    '(no events.json or events-YYYY-MM.json found)');
  process.exit(1);
}
context.backupSource = sourceArg;

async.series([
  function inputServiceInfo (done) {
    readP({ prompt: 'Service info URL: ', silent: false }, function (err, serviceInfoUrl) {
      if (!serviceInfoUrl || serviceInfoUrl.trim().length === 0) {
        serviceInfoUrl = 'https://reg.pryv.me/service/info';
        console.log('Using default serviceInfoUrl: ' + serviceInfoUrl);
      }
      context.service = new pryv.Service(serviceInfoUrl);
      done(err);
    });
  },
  function checkServiceInfo (done) {
    context.service.info().then(function (result) {
      context.info = result;
      console.log('Ready to login service: ' + context.info.name);
      done();
    }, done);
  },
  function inputUsername (done) {
    readP({ prompt: 'Username : ', silent: false }, function (err, username) {
      context.username = username;
      done(err);
    });
  },
  function inputPassword (done) {
    readP({ prompt: 'Password : ', silent: true }, function (err, password) {
      context.password = password;
      done(err);
    });
  },
  function login (done) {
    context.service.login(context.username, context.password, 'restore-bkp').then(function (connection) {
      context.connection = connection;
      done();
    }, done);
  },
  function doRestore (done) {
    console.log('starting restore');
    restore(context.connection, context.backupSource, context.options).then(function (report) {
      for (const line of report.toLines()) console.log(line);
      if (report.hasFailures()) {
        console.log('Restore incomplete: ' + report.failureCount() +
          ' call(s) refused by the target (full answers in the res_*.log files).');
        process.exitCode = 1;
      }
      done();
    }, done);
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
    process.exitCode = 1;
  }
});
