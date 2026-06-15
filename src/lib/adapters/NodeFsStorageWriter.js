const fs = require('fs');
const path = require('path');
const StorageWriter = require('./StorageWriter');

/**
 * Node-fs StorageWriter — writes directly to a directory on the local disk.
 *
 * Used by the CLI flavor (`scripts/start-backup.js`). The browser flavor uses
 * a Blob-accumulating ZIP writer instead (ships in the sample webapp).
 *
 * For backwards-compatibility with v0.5.0 callers, the constructor accepts
 * either:
 *   - a `baseDir` string (new, library-style), OR
 *   - an existing `BackupDirectory` instance (legacy, used by the v0.5.0 CLI).
 *
 * When given a `BackupDirectory`, the writer delegates to its `baseDir`
 * property and exposes the legacy properties (`eventsFile`, `accessesFile`,
 * `attachmentsDir`, etc.) verbatim so per-method modules calling
 * `backupDirectory.eventsFile` keep working in the Phase A transitional state.
 */
class NodeFsStorageWriter extends StorageWriter {
  /**
   * @param {string|BackupDirectory} baseDirOrLegacy
   */
  constructor (baseDirOrLegacy) {
    super();
    if (baseDirOrLegacy != null && typeof baseDirOrLegacy === 'object' && baseDirOrLegacy.baseDir) {
      // Legacy BackupDirectory — keep all its props for back-compat.
      this._legacy = baseDirOrLegacy;
      this.baseDir = baseDirOrLegacy.baseDir;
    } else if (typeof baseDirOrLegacy === 'string') {
      this.baseDir = baseDirOrLegacy.endsWith('/') ? baseDirOrLegacy : baseDirOrLegacy + '/';
    } else {
      throw new Error('NodeFsStorageWriter requires a baseDir string or a BackupDirectory-like object');
    }
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  openWriteStream (relPath) {
    const fullPath = path.resolve(this.baseDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    return fs.createWriteStream(fullPath, { encoding: 'utf8' });
  }

  exists (relPath) {
    return fs.existsSync(path.resolve(this.baseDir, relPath));
  }

  // CLI: each openWriteStream commits to disk immediately; no batch to finalize.
  async finalizeBatch () {}

  describeTarget () {
    return this.baseDir;
  }

  /**
   * Backwards-compatibility: when the writer wraps a legacy `BackupDirectory`,
   * expose the underlying instance so per-method modules that still consume
   * paths like `backupDirectory.eventsFile` work without modification. Will
   * be removed after Phase B migrates the per-method modules to consume the
   * writer directly.
   *
   * @returns {BackupDirectory|null}
   */
  legacyDirectory () {
    return this._legacy || null;
  }
}

module.exports = NodeFsStorageWriter;
