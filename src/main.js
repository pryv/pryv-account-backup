const fs = require('fs');
const async = require('async');
const _ = require('lodash');
const apiResources = require('./methods/api-resources');
const attachments = require('./methods/attachments');
const superagent = require('superagent');
const parseDomain = require('parse-domain');
const url = require('url');

const appId = 'pryv-backup';
async function signInToPryv (params, callback) {
  try {
    const serviceInfo = await fetchServiceInfo(params.serviceInfoUrl, params.username);
    const apiUrl = serviceInfo.apiUrl;
    const regUrl = serviceInfo.regUrl;
    const parsedDomain = parseDomain(apiUrl);
    const domain = parsedDomain.domain + '.' + parsedDomain.tld;

    if(apiUrl == null || regUrl == null || domain == null) {
      return callback(new Error('Unable to fetch apiUrl : ' + apiUrl + ' or regUrl : ' + regUrl + ' or domain : ' + domain));
    }
    params.apiUrl = apiUrl;

    const origin = 'https://sw.' + domain;
    console.log('Connecting to ' + apiUrl);  
    const connection = await login(params.username, params.password, apiUrl, regUrl, domain, origin);
    callback(null, connection);
  }
  catch(error) {
    console.error('Unable to reach service info at ' + params.serviceInfoUrl + ' : ' + JSON.stringify(error, null, 2));
    callback(error);
  }
}

async function login(username, password, apiUrl, regUrl, domain, origin) {
  const regAccessBody = {
    'requestingAppId': appId,
    'requestedPermissions': [{
      'streamId': '*',
      'level': 'read',
      'defaultName': 'backup'
    }],
    'languageCode': 'fr'
  };
  const authLoginBody = {
    "appId": appId,
    "username": username,
    "password": password
  }

  regUrl = url.resolve(regUrl, 'access');
  const resultReg = await superagent.post(regUrl)
    .set('Content-Type', 'application/json')
    .send(regAccessBody);
  if(resultReg.body.code != 201 || resultReg.body.status.indexOf('NEED_SIGNIN') != 0) {
    throw(new Error('Error while trying to reach ' + regUrl + ' : ' + JSON.stringify(resultReg, null, 2)));
  }

  const authLoginUrl = url.resolve(apiUrl, 'auth/login');
  const resultAuth = await superagent.post(authLoginUrl)
    .set('Content-Type', 'application/json')
    .set('Origin', origin)
    .send(authLoginBody);
  const token = resultAuth.body.token;
  if(token == null) {
    throw(new Error('Error while trying to reach ' + authLoginUrl + ' : ' + JSON.stringify(resultAuth, null, 2)));
  }

  return {'auth': token, 'username': username, 'apiUrl': apiUrl, 'settings': {'port': 443, 'domain': domain}};
}

async function fetchServiceInfo(serviceInfoUrl, username) {
  const serviceInfoRes = await superagent.get(serviceInfoUrl);
  const apiUrl = serviceInfoRes.body.api.replace('{username}', username);
  const regUrl = serviceInfoRes.body.register;
  return {
    apiUrl: apiUrl,
    regUrl: regUrl
  };
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
  const apiUrl = params.apiUrl;

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
        const tempConnection = {'auth': access.token, 'settings': connection.settings};
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