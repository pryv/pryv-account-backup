const fs = require('fs');
const async = require('async');
const read = require('read');
const backup = require('../src/main');
const BackupDirectory = require('../src/methods/backup-directory');
const pryv = require('pryv');
const context = {};

// read v5+ returns a Promise instead of taking a callback. Wrap so the existing
// async.series chain stays intact without rewriting the script.
function readP (opts, callback) {
  read(opts).then((value) => callback(null, value)).catch(callback);
}

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
    context.service.info().then(function (result, err) {
      context.info = result;
      console.log('Ready to login service: ' + context.info.name);
      done(err);
    });
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
  function askIncludeTrashed (done) {
    readP({ prompt: 'Also fetch trashed data? Y/N (default N) : ', silent: false },
      function (err, res) {
        context.includeTrashed = (res.toLowerCase() === 'y');
        done(err);
      });
  },
  function askIncludeAttachments (done) {
    readP({ prompt: 'Also fetch attachment files? Y/N (default N) : ', silent: false },
      function (err, res) {
        context.includeAttachments = (res.toLowerCase() === 'y');
        done(err);
      });
  },
  function askIncludeAccessHistory (done) {
    readP({
      prompt: 'Also fetch per-access version history? (O(N) calls, default N) Y/N : ',
      silent: false
    }, function (err, res) {
      context.includeAccessHistory = (res.toLowerCase() === 'y');
      done(err);
    });
  },
  function askEventsChunkMonths (done) {
    readP({ prompt: 'Events chunk size in months (default 1) : ', silent: false },
      function (err, res) {
        const n = parseInt((res || '').trim(), 10);
        context.eventsChunkMonths = (Number.isFinite(n) && n > 0) ? n : 1;
        done(err);
      });
  },
  function askOverwriteEvents (done) {
    const apiEndpoint = pryv.Service.buildAPIEndpoint(context.info, context.username);
    context.backupDirectory = new BackupDirectory(apiEndpoint);
    if (context.backupDirectory.hasEventsData()) {
      readP({
        prompt: 'Event files already exist in ' + context.backupDirectory.baseDir + '. ' +
          'Restart attachments sync only?\n' +
          '[N] will delete existing event files and backup everything Y/N ? (default Y)',
        silent: false
      }, function (err, resetQ) {
        if (resetQ.toLowerCase() === 'n') {
          // Remove legacy single-file + all chunked event files so the
          // backup re-fetches from scratch.
          for (const file of context.backupDirectory.listEventFiles()) {
            fs.unlinkSync(file);
          }
          console.log('Full backup restart');
        }
        done(err);
      });
    } else {
      done();
    }
  },
  function doBackup (stepDone) {
    backup.start(context, stepDone);
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});
