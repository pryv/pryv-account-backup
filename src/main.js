const pryv = require('pryv');
const fs = require('fs');
const async = require('async');
const _ = require('lodash');
const apiResources = require('./methods/api-resources');
const attachments = require('./methods/attachments');
const { URL } = require('url');
const superagent = require('superagent');
const parseDomain = require("parse-domain");

let apiUrl;
async function signInToPryv (params, callback) {
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

  try { // service info
    const serviceInfoUrl = params.domain;
    new URL(serviceInfoUrl); // Check if serviceInfoUrl is a valid url

    const parsedDomain = parseDomain(serviceInfoUrl);
    params.domain = parsedDomain.domain + '.' + parsedDomain.tld;
    apiUrl = await fetchApiUrl(serviceInfoUrl, params.username);
  }
  catch(error) { // domain
    if(error.code !== 'ERR_INVALID_URL') {
      console.error(error); // Unknown error
      return;
    }
    apiUrl = params.username + '.' + params.domain;
  }
  params.origin = 'https://sw.' + params.domain;

  console.log('Connecting to ' + apiUrl);

  pryv.Connection.login(params, callback);
}

async function fetchApiUrl(serviceInfoUrl, username) {
  try {
    const serviceInfoRes = await superagent.get(serviceInfoUrl);
    return serviceInfoRes.body.api.replace('{username}', username)
  } catch (error) {
    console.error('Unable to reach service info at ' + serviceInfoUrl + ' : ' + JSON.stringify(error, null, 2));
  }
  return '';
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
  signInToPryv(params, function(err, conn) {
    if (err) {
      console.log('Connection failed with Error:', err);
      return callback(err);
    }
    startOnConnection(conn, params, callback);
  });
};

function startOnConnection (connection, params, callback, log) {
  const backupDirectory = params.backupDirectory;

  if (!log) {
    log = console.log;
  }

  async.series([
    function createDirectoryTree(done) {
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
          'followed-slices', 'profile/private' , 'profile/public', eventsRequest],
        function (resource, callback) {
          apiResources.toJSONFile({
            folder: backupDirectory.baseDir,
            resource: resource,
            connection: connection,
            apiUrl: apiUrl
          }, callback, log)
        }, done);
    },
    function fetchAppProfiles (stepDone) {
      const accessesData = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
      async.mapSeries(accessesData.accesses, function(access, callback) {
        if (access.type !== 'app') {
          return callback();
        }
        const tempConnection = new pryv.Connection({
          username: connection.username,
          domain: connection.domain || connection.settings.domain,
          auth: access.token
        });
        apiResources.toJSONFile({
          folder: backupDirectory.appProfilesDir,
          resource: 'profile/app',
          extraFileName: '_' + access.id,
          connection: tempConnection,
          apiUrl: apiUrl
        }, callback, log);
      },stepDone);
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
exports.signInToPryv = signInToPryv;
exports.startOnConnection = startOnConnection;