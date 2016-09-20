var pryv = require('Pryv'),
  fs = require('fs'),
  https = require('https'),
  async = require('async'),
  read = require('read'),
  BackupDir = require('./methods/backup-directory'),
  apiResources = require('./methods/api-resources'),
  attachments = require('./methods/attachments');

// TODO will modularize this
var exporter = {};
module.exports = exporter;

var backupDirectory = null;

// -- go
var authSettings = {
    appId: 'pryv-backup',
    username: null,
    auth: null,
    port: 443,
    ssl: true,
    domain: false
  },
  connection = null;

async.series([
  function inputDomain(done) {
    read({prompt: 'Domain (default: pryv.me): ', silent: false}, function (er, domain) {
      authSettings.domain = domain || 'pryv.me';
      authSettings.origin = 'https://sw.' + authSettings.domain;
      done(er);
    });
  },
  function inputUsername(done) {
    read({prompt: 'Username : ', silent: false}, function (er, username) {
      authSettings.username = username;
      done(er);
    });
  },
  function inputPassword(done) {
    read({prompt: 'Password : ', silent: true}, function (er, password) {
      authSettings.password = password;
      done(er);
    });
  },
  function createDirectoryTree(done) {
    backupDirectory =
      new BackupDir(authSettings.username, authSettings.domain);
    console.log(backupDirectory);
    backupDirectory.createDirs(done);
  },
  function signInToPryv(done) {
    console.log('Connecting to ' + authSettings.username + '.' + authSettings.domain);

    pryv.Connection.login(authSettings, function (err, conn) {
      if (err) {
        console.log('Connection failed with Error:', err);
        return done(err);
      }
      connection = conn;
      done();
    });
  },
  function askOverwriteEvents(done) {
    if (fs.existsSync(backupDirectory.eventsFile)) {
      read({
        prompt: backupDirectory.eventsFile + ' exists, restart attachments sync only?\n' +
        '[N] will delete current events.json file and backup everything Y/N ? (default Y)',
        silent: false
      }, function (err, resetQ) {
        if (resetQ.toLowerCase() === 'n') {
          fs.unlinkSync(backupDirectory.eventsFile);
          console.log('Full backup restart');
        }
        done(err);
      });
    } else {
      done();
    }
  },
  function askIncludeTrashed(done) {
    read({prompt: 'Also fetch trashed data? Y/N (default N) : ', silent: false},
      function (er, res) {
        authSettings.includeTrashed = (res.toLowerCase() === 'y');
        done(er);
      });
  },
  function askIncludeAttachments(done) {
    read({prompt: 'Also fetch attachment files? Y/N (default N) : ', silent: false},
      function (er, res) {
        authSettings.includeAttachments = (res.toLowerCase() === 'y');
        done(er);
      });
  },
  function (done) {
    console.log('Starting Backup');

    // TODO we skip all info if events are skipped - need more granularity
    if (fs.existsSync(backupDirectory.eventsFile)) { // skip
      return done();
    }

    var eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000;
    var streamsRequest = 'streams';
    if (authSettings.includeTrashed) {
      eventsRequest += '&state=all';
      streamsRequest += '?&state=all';
    }

    async.mapSeries(['account', streamsRequest, 'accesses',
        'followed-slices', 'profile/public', eventsRequest],
      function (resource, callback) {
        apiResources.toJSONFile({
          folder: backupDirectory.baseDir,
          resource: resource,
          connection: connection
        }, callback)
      }, function (err) {
        done(err);
      });
  },
  function fetchAttachments(stepDone) {
    if (authSettings.includeAttachments) {
      attachments.download(connection, backupDirectory, stepDone);
    } else {
      console.log('skipping attachments');
      stepDone();
    }
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});
