const fs = require('fs');
const async = require('async');
const apiResources = require('./methods/api-resources');
const attachments = require('./methods/attachments');
const hfData = require('./methods/hf-data');
const webhooksExport = require('./methods/webhooks-export');
const manifest = require('./methods/manifest');
const pryv = require('pryv');
const pkg = require('../package.json');

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
      let auditLogsRequest = 'audit/logs?fromTime=-2350373077&toTime=2350373077';
      if (params.includeTrashed) {
        eventsRequest += '&state=all';
        streamsRequest += '?state=all';
      }

      // Plan 72 Phase C: dropped 'followed-slices' (v1-only, returns 404 in v2).
      // Added 'audit/logs' (C.1) — fetched alongside the rest as a JSON file.
      async.mapSeries(['account', streamsRequest, 'accesses',
        'profile/private', 'profile/public',
        eventsRequest, auditLogsRequest]
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
    },
    // Plan 72 Phase C.2: fetch HFS data points for every series:* event.
    function fetchHFData (stepDone) {
      hfData.download(connection, backupDirectory, stepDone, log);
    },
    // Plan 72 Phase C.3: fetch webhooks per-access.
    function fetchWebhooks (stepDone) {
      webhooksExport.download(connection, backupDirectory, stepDone, log);
    },
    // Plan 72 Phase C: per-file sha256 integrity manifest.
    function writeManifest (stepDone) {
      manifest.generate(backupDirectory.baseDir, { version: pkg.version, log }, stepDone);
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
