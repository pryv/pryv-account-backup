var pryv = require('pryv'),
  fs = require('fs'),
  async = require('async'),
  _ = require('lodash'),
  apiResources = require('./methods/api-resources'),
  attachments = require('./methods/attachments');

/**
 * Downloads the user data in
 *
 * @param params {object}
 *        params.username {string}
 *        params.password {string}
 *        params.domain {string}
 *        params.includeTrashed {boolean}
 *        params.includeAttachments {boolean}
 *        params.backupDirectory {backup-directory}
 */
exports.start = function (params, callback) {

  var backupDirectory = params.backupDirectory,
    connection = null;

  params = _.extend({
    appId: 'pryv-backup',
    username: null,
    auth: null,
    port: 443,
    ssl: true,
    domain: false,
    includeTrashed: false,
    includeAttachments: false
  }, params);

  params.origin = 'https://sw.' + params.domain;

  async.series([
    function createDirectoryTree(done) {
      backupDirectory.createDirs(done);
    },
    function signInToPryv(done) {
      console.log('Connecting to ' + params.username + '.' + params.domain);

      pryv.Connection.login(params, function (err, conn) {
        if (err) {
          console.log('Connection failed with Error:', err);
          return done(err);
        }
        connection = conn;
        done();
      });
    },
    function fetchData (done) {
      console.log('Starting Backup');

      // TODO we skip all data if events are skipped - need more granularity
      if (fs.existsSync(backupDirectory.eventsFile)) { // skip
        return done();
      }

      var eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000;
      var streamsRequest = 'streams';
      if (params.includeTrashed) {
        eventsRequest += '&state=all';
        streamsRequest += '?state=all';
      }

      async.mapSeries(['account', streamsRequest, 'accesses',
          'followed-slices', 'profile/public', eventsRequest],
        function (resource, callback) {
          apiResources.toJSONFile({
            folder: backupDirectory.baseDir,
            resource: resource,
            connection: connection
          }, callback)
        }, done);
    },
    function fetchAttachments (stepDone) {
      if (params.includeAttachments) {
        attachments.download(connection, backupDirectory, stepDone);
      } else {
        console.log('skipping attachments');
        stepDone();
      }
    }
  ], function (err) {
    if (err) {
      console.error('Failed in process with error', err);
      return callback(err);
    }
    callback();
  });
};

/**
 * Expose BackupDirectory as well since it is a parameter of .start()
 */
exports.Directory = require('./methods/backup-directory');