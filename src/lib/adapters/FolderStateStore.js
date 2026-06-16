const fs = require('fs');
const path = require('path');
const StateStore = require('./StateStore');

/**
 * Folder-backed StateStore — persists state to `<baseDir>/.sync-state.json`
 * (hidden). Used by the CLI flavor.
 *
 * The file holds the union of kv state (incremental thresholds + tool
 * metadata) and per-category work refs (attachment / series-event / webhook
 * discovered during a run + their done-state). It is loaded at startup and
 * rewritten on each `flush()` (set/markDone/clearCategory call `flush`
 * eagerly, so no caller-side `flush()` is strictly required).
 *
 * Migration: if `.sync-state.json` is absent but the legacy `.state.json`
 * (pre-v0.7.0) is present, its kv state is loaded as-is; the next write
 * lands in `.sync-state.json` and the legacy file is left in place (Node
 * fs is forgiving; the legacy reader becomes inert without orchestrator
 * support).
 *
 * Companion export: `Backup.run()` writes a kv-only `sync-state.json`
 * (no dot, visible) into the backup directory at run-end via the writer —
 * that's the file a subject keeps and re-uploads on the next run. The
 * hidden `.sync-state.json` carries refs and is the operational store;
 * the exported `sync-state.json` is the portable artefact.
 */
class FolderStateStore extends StateStore {
  /**
   * @param {string} baseDir backup root directory
   */
  constructor (baseDir) {
    super();
    this.baseDir = baseDir;
    this.stateFile = path.resolve(baseDir, '.sync-state.json');
    this._legacyStateFile = path.resolve(baseDir, '.state.json');
    this._state = this._load();
  }

  _load () {
    const empty = { kv: {}, refs: {} };
    let raw = null;
    if (fs.existsSync(this.stateFile)) {
      try { raw = fs.readFileSync(this.stateFile, 'utf8'); } catch (_) { return empty; }
    } else if (fs.existsSync(this._legacyStateFile)) {
      // Pre-v0.7.0 layout — flat kv object at the file root.
      try {
        const flat = JSON.parse(fs.readFileSync(this._legacyStateFile, 'utf8'));
        return { kv: flat && typeof flat === 'object' ? flat : {}, refs: {} };
      } catch (_) { return empty; }
    } else {
      return empty;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return empty; }
    if (parsed == null || typeof parsed !== 'object') return empty;
    return {
      kv: parsed.kv && typeof parsed.kv === 'object' ? parsed.kv : {},
      refs: parsed.refs && typeof parsed.refs === 'object' ? parsed.refs : {}
    };
  }

  // ─── Key/value state ───

  async get (key) {
    return this._state.kv[key];
  }

  async set (key, value) {
    this._state.kv[key] = value;
    await this.flush();
  }

  async getAll () {
    return { ...this._state.kv };
  }

  async flush () {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2));
  }

  // ─── Per-category ref tracking ───

  async pushRef (category, ref) {
    if (ref == null || typeof ref.key !== 'string') {
      throw new Error('StateStore.pushRef requires ref.key (string)');
    }
    const list = this._state.refs[category] || (this._state.refs[category] = []);
    if (list.some((r) => r.key === ref.key)) return; // idempotent
    list.push({ ...ref, done: false });
    await this.flush();
  }

  async listPending (category) {
    const list = this._state.refs[category] || [];
    return list.filter((r) => !r.done).map((r) => ({ ...r }));
  }

  async markDone (category, refKey) {
    const list = this._state.refs[category] || [];
    const found = list.find((r) => r.key === refKey);
    if (found) {
      found.done = true;
      await this.flush();
    }
  }

  async clearCategory (category) {
    if (this._state.refs[category]) {
      delete this._state.refs[category];
      await this.flush();
    }
  }

  // ─── Portable export / import ───

  async export () {
    return {
      format: StateStore.FORMAT,
      formatVersion: StateStore.FORMAT_VERSION,
      toolVersion: this._state.kv.toolVersion || null,
      createdAt: new Date().toISOString(),
      kv: { ...this._state.kv }
    };
  }

  async import (data) {
    if (data == null || data.format !== StateStore.FORMAT) {
      throw new Error('StateStore.import: unrecognized format (expected ' +
        StateStore.FORMAT + ')');
    }
    if (data.formatVersion !== StateStore.FORMAT_VERSION) {
      throw new Error('StateStore.import: unsupported formatVersion ' +
        data.formatVersion + ' (expected ' + StateStore.FORMAT_VERSION + ')');
    }
    this._state.kv = (data.kv && typeof data.kv === 'object') ? { ...data.kv } : {};
    await this.flush();
  }
}

module.exports = FolderStateStore;
