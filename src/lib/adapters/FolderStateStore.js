const fs = require('fs');
const path = require('path');
const StateStore = require('./StateStore');

/**
 * Folder-backed StateStore — persists state to a `.state.json` sentinel file
 * inside the backup directory. Used by the CLI flavor.
 *
 * The state file holds incremental-run metadata: `lastRunAt`,
 * `lastModifiedSince` per resource, tool version, format version. It is read
 * at startup and rewritten on each `set` / `flush` call. The file is at the
 * root of the backup directory (alongside `account.json`, `manifest.json`,
 * etc.) and is included in the integrity manifest like any other file.
 *
 * Phase A: the orchestrator does not yet consume state; this class is wired
 * for Phase B which writes the incremental timestamps.
 */
class FolderStateStore extends StateStore {
  /**
   * @param {string} baseDir backup root directory
   */
  constructor (baseDir) {
    super();
    this.baseDir = baseDir;
    this.stateFile = path.resolve(baseDir, '.state.json');
    this._state = this._load();
  }

  _load () {
    if (!fs.existsSync(this.stateFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (err) {
      // Corrupted state file — start fresh rather than aborting the backup.
      return {};
    }
  }

  async get (key) {
    return this._state[key];
  }

  async set (key, value) {
    this._state[key] = value;
    await this.flush();
  }

  async getAll () {
    return { ...this._state };
  }

  async flush () {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2));
  }
}

module.exports = FolderStateStore;
