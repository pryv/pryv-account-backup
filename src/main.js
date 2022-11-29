const fs = require('fs');
const async = require('async');
const _ = require('lodash');
const apiResources = require('./methods/api-resources');
const attachments = require('./methods/attachments');
const url = require('url');
const pryv = require('pryv');

const appId = 'pryv-backup';

async function signInToPryv(context) {
  if (!context.service) {
    context.service = new pryv.Service(context.serviceInfoUrl);
  }
  const infos = await context.service.info();
  if (!context.origin) {
    const url = new URL(infos.register);
    context.origin = url.protocol + '//' + url.hostname; // let's try with the url of service info
  }
  console.log('Login with origin: ' + context.origin);
  return await context.service.login(context.username, context.password, appId, context.origin);
}


/**
 * Downloads the user data in folder `./backup/apiEndpoint/`
 *
 * @param params {object}
 *        params.username {string}
 *        params.password {string}
 *        params.serviceInfoUrl {string}
 *        params.includeTrashed {boolean}
 *        params.includeAttachments {boolean}
 *        params.backupDirectory {backup-directory}
 * @param callback {function}
 */
exports.start = function (params, callback) {
  signInToPryv(params).then(function (connection, err) {
    if (err) {
      console.log('Connection failed with Error:', err);
      return callback(err);
    }
    startOnConnection(connection, params, callback);
  });
};

function startOnConnection (connection, params, callback, log) {
  const backupDirectory = params.backupDirectory;

  if (!log) {
    log = console.log;
  }

  async.series([
    function createDirectoryTree (done) {
      backupDirectory.createDirs(done, log);
    },
    function fetchData (done) {
      log('Starting Backup');

      // TODO we skip all data if events are skipped - need more granularity
      if (fs.existsSync(backupDirectory.eventsFile)) { // skip
        return done();
      }

      let eventsRequest = 'events?fromTime=-2350373077&toTime=2350373077';
      let streamsRequest = 'streams';
      if (params.includeTrashed) {
        eventsRequest += '&state=all';
        streamsRequest += '?state=all';
      }

      async.mapSeries(['account', streamsRequest, 'accesses',
        'followed-slices', 'profile/private', 'profile/public', 
        eventsRequest]
        ,
        function (resource, callback) {
          apiResources.toJSONFile({
            folder: backupDirectory.baseDir,
            resource: resource,
            connection: connection
          }, callback, log)
        }, done);
    },
    function fetchAppProfiles (stepDone) {
      const accessesData = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
      async.mapSeries(accessesData.accesses, function (access, callback) {
        if (access.type !== 'app') {
          return callback();
        }
        apiResources.toJSONFile({
          folder: backupDirectory.appProfilesDir,
          resource: 'profile/app',
          extraFileName: '_' + access.id,
          connection: { endpoint: connection.endpoint, token: access.token }
        }, callback, log);
      }, stepDone);
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
}

/**
 * Expose BackupDirectory as well since it is a parameter of .start()
 */
exports.Directory = require('./methods/backup-directory');
exports.startOnConnection = startOnConnection;
exports.signInToPryv = signInToPryv;
