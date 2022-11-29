const fs = require('fs');
const async = require('async');
const read = require('read');
const backup = require('../src/main');
const BackupDirectory = require('../src/methods/backup-directory');
const pryv = require('pryv');
const context = {};

async.series([
  function inputServiceInfo(done) {
    read({ prompt: 'Service info URL: ', silent: false }, function (err, serviceInfoUrl) {
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
  }
  , function inputUsername (done) {
    read({ prompt: 'Username : ', silent: false }, function (err, username) {
      context.username = username;
      done(err);
    });
  },
  function inputPassword (done) {
    read({ prompt: 'Password : ', silent: true }, function (err, password) {
      context.password = password;
      done(err);
    });
  },
  function askIncludeTrashed (done) {
    read({ prompt: 'Also fetch trashed data? Y/N (default N) : ', silent: false },
      function (err, res) {
        context.includeTrashed = (res.toLowerCase() === 'y');
        done(err);
      });
  },
  function askIncludeAttachments (done) {
    read({ prompt: 'Also fetch attachment files? Y/N (default N) : ', silent: false },
      function (err, res) {
        context.includeAttachments = (res.toLowerCase() === 'y');
        done(err);
      });
  },
  function askOverwriteEvents (done) {
    const apiEndpoint = pryv.Service.buildAPIEndpoint(context.info, context.username);
    context.backupDirectory = new BackupDirectory(apiEndpoint);
    if (fs.existsSync(context.backupDirectory.eventsFile)) {
      read({
        prompt: context.backupDirectory.eventsFile + ' exists, restart attachments sync only?\n' +
          '[N] will delete current events.json file and backup everything Y/N ? (default Y)',
        silent: false
      }, function (err, resetQ) {
        if (resetQ.toLowerCase() === 'n') {
          fs.unlinkSync(context.backupDirectory.eventsFile);
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
