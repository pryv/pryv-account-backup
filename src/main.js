const fs = require('fs');
const async = require('async');
const apiResources = require('./methods/api-resources');
const attachments = require('./methods/attachments');
const hfData = require('./methods/hf-data');
const webhooksExport = require('./methods/webhooks-export');
const eventsChunked = require('./methods/events-chunked');
const accessesHistory = require('./methods/accesses-history');
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

      // Skip on re-run if any events chunk file (or the legacy `events.json`)
      // already exists. Granularity is "events present? skip the metadata
      // resources too" — same behavior as pre-chunked versions.
      if (backupDirectory.hasEventsData()) { // skip
        return done();
      }

      let streamsRequest = 'streams';
      const auditLogsRequest = 'audit/logs?fromTime=-2350373077&toTime=2350373077';
      if (params.includeTrashed) {
        streamsRequest += '?state=all';
      }

      // 'followed-slices' is v1-only (returns 404 in v2) — not fetched.
      // Events are fetched separately as monthly chunks (see fetchEventsChunked
      // below); audit/logs is still a single resource.
      //
      // `accesses` is fetched twice: once as the current-snapshot
      // `accesses.json` (back-compat, unchanged shape), once with
      // `includeDeletions=true&includeExpired=true` as `accesses-all.json`
      // so the dump carries the full disclosure-history view (revoked +
      // expired tokens) needed for consent-state-at-time-of-access
      // provenance.
      const accessesAllRequest = 'accesses?includeDeletions=true&includeExpired=true';
      async.mapSeries(['account', streamsRequest, 'accesses', accessesAllRequest,
        'profile/private', 'profile/public',
        auditLogsRequest]
        ,
        function (resource, callback) {
          // Force `accesses-all.json` for the deletions+expired variant so it
          // doesn't collide with the bare `accesses.json` filename derived
          // from the resource string.
          const extra = resource === accessesAllRequest ? '-all' : '';
          apiResources.toJSONFile({
            folder: backupDirectory.baseDir,
            resource: resource,
            extraFileName: extra,
            connection: connection
          }, callback, log)
        }, done);
    },
    function fetchEventsChunked (stepDone) {
      eventsChunked.download(connection, backupDirectory, {
        includeTrashed: params.includeTrashed,
        fromTime: params.fromTime,
        toTime: params.toTime,
        chunkMonths: params.eventsChunkMonths
      }, stepDone, log);
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
    function fetchAccessHistory (stepDone) {
      // O(N) in the access count — opt-in via params.includeAccessHistory.
      if (!params.includeAccessHistory) {
        log('Skipping per-access version history (opt-in)');
        return stepDone();
      }
      accessesHistory.download(connection, backupDirectory, stepDone, log);
    },
    function fetchAttachments (stepDone) {
      if (params.includeAttachments) {
        attachments.download(connection, backupDirectory, stepDone, log);
      } else {
        log('Skipping attachments');
        stepDone();
      }
    },
    // Fetch HFS data points for every series:* event.
    function fetchHFData (stepDone) {
      hfData.download(connection, backupDirectory, stepDone, log);
    },
    // Fetch webhooks per-access.
    function fetchWebhooks (stepDone) {
      webhooksExport.download(connection, backupDirectory, stepDone, log);
    },
    // Write the per-file sha256 integrity manifest.
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
