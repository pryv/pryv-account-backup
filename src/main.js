var pryv = require('pryv'),
  fs = require('fs'),
  async = require('async'),
  _ = require('lodash'),
  apiResources = require('./methods/api-resources'),
  attachments = require('./methods/attachments');


exports.signInToPryv = function (params, callback) {
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

  console.log('Connecting to ' + params.username + '.' + params.domain);

  pryv.Connection.login(params, callback);
}


/**
 * Downloads the user data in folder `./backup/username.domain/`
 *
 * @param params {object}
 *        params.username {string}
 *        params.password {string}
 *        params.domain {string}
 *        params.includeTrashed {boolean}
 *        params.includeAttachments {boolean}
 *        params.backupDirectory {backup-directory}
 * @param callback {function}
 */
exports.start = function (params, callback) {
  exports.signInToPryv(params, function(err, conn) {
    if (err) {
      console.log('Connection failed with Error:', err);
      return callback(err);
    }
    exports.startOnConnection(conn, params, callback);
  });
};

exports.startOnConnection = function (connection, params, callback, log) {
  var backupDirectory = params.backupDirectory;

  if (!log) {
    log = console.log;
  }

  async.series([
    function createDirectoryTree(done) {
      backupDirectory.createDirs(done);
    },
    function fetchData (done) {
      log('Starting Backup');

      // TODO we skip all data if events are skipped - need more granularity
      if (fs.existsSync(backupDirectory.eventsFile)) { // skip
        return done();
      }

      var eventsRequest = 'events?fromTime=-2350373077&toTime=2350373077';
      var streamsRequest = 'streams';
      if (params.includeTrashed) {
        eventsRequest += '&state=all';
        streamsRequest += '?state=all';
      }

      async.mapSeries(['account', streamsRequest, 'accesses',
          'followed-slices', 'profile/private' , 'profile/public', eventsRequest],
        function (resource, callback) {
          apiResources.toJSONFile({
            folder: backupDirectory.baseDir,
            resource: resource,
            connection: connection
          }, callback, log)
        }, done);
    },
    function fetchAttachments (stepDone) {
      if (params.includeAttachments) {
        attachments.download(connection, backupDirectory, stepDone, log);
      } else {
        log('Skipping attachments');
        stepDone();
      }
    }
  ], function (err) {
    if (err) {
      log('Failed in process with error' + err);
      return callback(err);
    }
    callback();
  });
};

/**
 * Expose BackupDirectory as well since it is a parameter of .start()
 */
exports.Directory = require('./methods/backup-directory');