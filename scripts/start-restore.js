const async = require('async');
const read = require('read');
const backup = require('../src/main');
const BackupDirectory = require('../src/methods/backup-directory');

const authSettings = {};

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
  function inputBackupUsername(done) {
    read({prompt: 'Backup username : ', silent: false}, function (err, username) {
      authSettings.backupUsername = username;
      done(err);
    });
  },
  function doBackup(stepDone) {
    authSettings.backupFolder = new BackupDirectory(authSettings.backupUsername, authSettings.domain);
    backup.startRestore(authSettings, stepDone);
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});
