var fs = require('fs'),
  async = require('async'),
  read = require('read'),
  backup = require('../src/main'),
  BackupDirectory = require('../src/methods/backup-directory');

var authSettings = {};

async.series([
  function inputDomain(done) {
    read({prompt: 'Domain (default: pryv.me): ', silent: false}, function (err, domain) {
      authSettings.domain = domain || 'pryv.me';
      done(err);
    });
  },
  function inputUsername(done) {
    read({prompt: 'Username : ', silent: false}, function (err, username) {
      authSettings.username = username;
      done(err);
    });
  },
  function inputPassword(done) {
    read({prompt: 'Password : ', silent: true}, function (err, password) {
      authSettings.password = password;
      done(err);
    });
  },
  function askIncludeTrashed(done) {
    read({prompt: 'Also fetch trashed data? Y/N (default N) : ', silent: false},
      function (err, res) {
        authSettings.includeTrashed = (res.toLowerCase() === 'y');
        done(err);
      });
  },
  function askIncludeAttachments(done) {
    read({prompt: 'Also fetch attachment files? Y/N (default N) : ', silent: false},
      function (err, res) {
        authSettings.includeAttachments = (res.toLowerCase() === 'y');
        done(err);
      });
  },
  function askOverwriteEvents(done) {
    authSettings.backupDirectory = new BackupDirectory(authSettings.username, authSettings.domain);
    if (fs.existsSync(authSettings.backupDirectory.eventsFile)) {
      read({
        prompt: authSettings.backupDirectory.eventsFile + ' exists, restart attachments sync only?\n' +
        '[N] will delete current events.json file and backup everything Y/N ? (default Y)',
        silent: false
      }, function (err, resetQ) {
        if (resetQ.toLowerCase() === 'n') {
          fs.unlinkSync(authSettings.backupDirectory.eventsFile);
          console.log('Full backup restart');
        }
        done(err);
      });
    } else {
      done();
    }
  },
  function doBackup(stepDone) {
    backup.start(authSettings, stepDone);
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});
