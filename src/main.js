/**
 * Legacy library entry — preserved for the v0.4.0+ callback-style API:
 *
 *   const backup = require('pryv-backup');
 *   backup.start({ username, password, serviceInfoUrl, backupDirectory, ... }, cb);
 *
 * New code should prefer the class-based library entry under `./lib/`:
 *
 *   const { Backup, NodeFsStorageWriter, FolderStateStore } = require('pryv-backup/lib');
 *
 * This shim:
 *   - handles the username/password → connection auth flow,
 *   - wraps the resulting connection in a `Backup` orchestrator,
 *   - delegates the rest to the library.
 */

const pryv = require('pryv');
const Backup = require('./lib/Backup');
const NodeFsStorageWriter = require('./lib/adapters/NodeFsStorageWriter');
const FolderStateStore = require('./lib/adapters/FolderStateStore');

const appId = 'pryv-backup';

async function signInToPryv (context) {
  if (!context.service) {
    context.service = new pryv.Service(context.serviceInfoUrl);
  }
  const infos = await context.service.info();
  if (!context.origin) {
    const url = new URL(infos.register);
    context.origin = url.protocol + '//' + url.hostname;
  }
  console.log('Login with origin: ' + context.origin);
  return await context.service.login(context.username, context.password, appId, context.origin);
}

/**
 * Downloads the user data in folder `./backup/apiEndpoint/`.
 *
 * @param params {object}
 *        params.username {string}
 *        params.password {string}
 *        params.serviceInfoUrl {string}
 *        params.includeTrashed {boolean}
 *        params.includeAttachments {boolean}
 *        params.includeAccessHistory {boolean}
 *        params.eventsChunkMonths {number}
 *        params.fromTime {number}
 *        params.toTime {number}
 *        params.backupDirectory {BackupDirectory}
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
  if (!log) log = console.log;
  const backupDirectory = params.backupDirectory;
  const writer = new NodeFsStorageWriter(backupDirectory);
  const state = new FolderStateStore(backupDirectory.baseDir);
  const backup = new Backup({
    connection,
    writer,
    state,
    options: {
      includeTrashed: params.includeTrashed,
      includeAttachments: params.includeAttachments,
      includeAccessHistory: params.includeAccessHistory,
      eventsChunkMonths: params.eventsChunkMonths,
      fromTime: params.fromTime,
      toTime: params.toTime
    },
    log
  });
  backup.run(callback);
}

// Public surface preserved verbatim from v0.5.0.
exports.Directory = require('./methods/backup-directory');
exports.startOnConnection = startOnConnection;
exports.signInToPryv = signInToPryv;

// Library exports — accessible as `require('@pryv/account-backup').Backup`
// in addition to the dedicated `require('@pryv/account-backup/lib')` entry.
const lib = require('./lib');
exports.Backup = lib.Backup;
exports.StorageWriter = lib.StorageWriter;
exports.StateStore = lib.StateStore;
exports.NodeFsStorageWriter = lib.NodeFsStorageWriter;
exports.FolderStateStore = lib.FolderStateStore;
