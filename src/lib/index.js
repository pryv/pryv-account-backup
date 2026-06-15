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
 * The legacy `require('@pryv/account-backup').start(...)` callback API still
 * works (see `src/main.js`) and constructs a `Backup` instance internally.
 */

const Backup = require('./Backup');
const StorageWriter = require('./adapters/StorageWriter');
const StateStore = require('./adapters/StateStore');
const NodeFsStorageWriter = require('./adapters/NodeFsStorageWriter');
const FolderStateStore = require('./adapters/FolderStateStore');

module.exports = {
  Backup,
  StorageWriter,
  StateStore,
  NodeFsStorageWriter,
  FolderStateStore
};
