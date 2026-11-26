/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
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
const { signInWithMfa } = require('./lib/signInWithMfa');

const appId = 'pryv-backup';

/**
 * Signs in with `context.username` / `context.password` and resolves with the
 * connection. For an account with multi-factor authentication active it uses
 * `context.mfaCode` (one attempt) or `context.onMfaRequired({ method, resend,
 * ... })` (async, returns the code; asked again after a wrong code, a bounded
 * number of times); with neither, lib-js's `MfaRequiredError` is rethrown.
 * See `./lib/signInWithMfa.js`.
 */
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
  return await signInWithMfa(context.service, context.username, context.password, appId, context.origin, {
    mfaCode: context.mfaCode,
    onMfaRequired: context.onMfaRequired
  });
}

/**
 * Downloads the user data in folder `./backup/apiEndpoint/`.
 *
 * @param params {object}
 *        params.username {string}
 *        params.password {string}
 *        params.mfaCode {string} optional, see `signInToPryv`
 *        params.onMfaRequired {function} optional, see `signInToPryv`
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
  signInToPryv(params).then(function (connection) {
    // A synchronous throw here would otherwise be an unhandled rejection.
    try {
      startOnConnection(connection, params, callback);
    } catch (err) {
      callback(err);
    }
  }, function (err) {
    // Reported by the caller (the CLI prints it once); not printed here too.
    callback(err);
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
exports.signInWithMfa = lib.signInWithMfa;
exports.isMfaRequired = lib.isMfaRequired;
exports.LOST_FACTOR_HINT = lib.LOST_FACTOR_HINT;
