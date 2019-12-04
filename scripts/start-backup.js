const fs = require('fs');
const async = require('async');
const read = require('read');
const backup = require('../src/main');
const BackupDirectory = require('../src/methods/backup-directory');
const superagent = require('superagent');
const parseDomain = require('parse-domain');
const authSettings = {};

async.series([
  function inputDomain(done) {
    read({prompt: 'Service info URL: ', silent: false}, function (err, serviceInfoUrl) {
      authSettings.serviceInfoUrl = serviceInfoUrl;
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
  function extractDomain(done) {
    superagent.get(authSettings.serviceInfoUrl)
      .then(serviceInfoRes => {
        const apiUrl = serviceInfoRes.body.api.replace('{username}', authSettings.username);
        const parsedDomain = parseDomain(apiUrl);
        const domain = parsedDomain.domain + '.' + parsedDomain.tld;
        authSettings.domain = domain
        done();
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
