/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * `@pryv/account-backup` library entrypoint.
 *
 *   const { Backup, NodeFsStorageWriter, FolderStateStore } = require('@pryv/account-backup/lib');
 *
 *   const writer = new NodeFsStorageWriter(backupDirectory);
 *   const state  = new FolderStateStore(backupDirectory.baseDir);
 *   const backup = new Backup({ connection, writer, state, options });
 *   backup.run((err) => { ... });
 *
 * `signInWithMfa(service, username, password, appId, origin, handlers)` signs
 * in with a password and completes a multi-factor challenge when the account
 * has one (see `./signInWithMfa.js`).
 *
 * The legacy `require('@pryv/account-backup').start(...)` callback API still
 * works (see `src/main.js`) and constructs a `Backup` instance internally.
 */

const Backup = require('./Backup');
const StorageWriter = require('./adapters/StorageWriter');
const StateStore = require('./adapters/StateStore');
const NodeFsStorageWriter = require('./adapters/NodeFsStorageWriter');
const FolderStateStore = require('./adapters/FolderStateStore');
const { signInWithMfa, isMfaRequired, LOST_FACTOR_HINT } = require('./signInWithMfa');

module.exports = {
  Backup,
  StorageWriter,
  StateStore,
  NodeFsStorageWriter,
  FolderStateStore,
  signInWithMfa,
  isMfaRequired,
  LOST_FACTOR_HINT
};
