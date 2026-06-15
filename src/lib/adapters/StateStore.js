/**
 * StateStore — interface for tracking incremental-backup progress + in-run
 * work refs.
 *
 * The library is consumed in two flavors:
 *   - CLI (Node): persists state to a sentinel file in the backup directory
 *     (FolderStateStore — `<baseDir>/.sync-state.json`).
 *   - Browser: persists state to `localStorage` (LocalStorageStateStore, ships
 *     in the sample webapp).
 *
 * Two concerns live in the store:
 *
 *   1. **Key/value state** (`get` / `set` / `getAll`): cross-session
 *      incremental thresholds (`lastRunAt`, `events.lastModifiedSince`,
 *      `audit.lastModifiedSince`, …) and tool metadata.
 *
 *   2. **Per-category refs** (`pushRef` / `listPending` / `markDone` / …):
 *      work-queue entries discovered during a fetch step and consumed by a
 *      later step — e.g. attachment refs discovered while events stream by,
 *      drained later by the attachments downloader.
 *
 * The store is also responsible for portable export/import:
 *
 *   - `export()` returns a JSON-able snapshot of the kv state (refs are
 *     deliberately dropped — they are per-run working data; the next run
 *     re-discovers any genuinely missing refs via `modifiedSince`).
 *   - `import(data)` replaces the kv state from a prior `export()` output —
 *     the cornerstone of browser-side cross-session incremental, since
 *     localStorage can be cleared / scoped to a single browser. The subject
 *     downloads `sync-state.json` at the end of a run and re-uploads it at
 *     the start of the next run.
 *
 * @abstract
 */
class StateStore {
  // ─── Key/value state ───

  /**
   * Retrieve a value previously set via `set`.
   * @param {string} key
   * @returns {Promise<unknown>}
   */
  async get (key) {
    throw new Error('StateStore.get not implemented');
  }

  /**
   * Set a value. Implementations may flush immediately or batch until
   * `flush()` is called.
   * @param {string} key
   * @param {unknown} value
   * @returns {Promise<void>}
   */
  async set (key, value) {
    throw new Error('StateStore.set not implemented');
  }

  /**
   * Return all key/value pairs currently stored.
   * @returns {Promise<Record<string, unknown>>}
   */
  async getAll () {
    throw new Error('StateStore.getAll not implemented');
  }

  /**
   * Persist any buffered state to its backing store.
   * @returns {Promise<void>}
   */
  async flush () {
    throw new Error('StateStore.flush not implemented');
  }

  // ─── Per-category ref tracking ───

  /**
   * Record a work ref under `category`. Idempotent on `ref.key` within a
   * category — re-pushing the same key is a no-op (the existing entry's
   * `done` flag is preserved).
   *
   * @param {string} category e.g. 'attachment', 'series-event', 'webhook'
   * @param {object} ref      must carry a `key` string; rest is opaque payload
   *                          consumed by the draining step (URL params, tokens, …)
   * @returns {Promise<void>}
   */
  async pushRef (category, ref) {
    throw new Error('StateStore.pushRef not implemented');
  }

  /**
   * List refs in `category` that have not yet been marked done.
   * @param {string} category
   * @returns {Promise<Array<object>>}
   */
  async listPending (category) {
    throw new Error('StateStore.listPending not implemented');
  }

  /**
   * Mark the ref keyed by `refKey` in `category` as done.
   * @param {string} category
   * @param {string} refKey
   * @returns {Promise<void>}
   */
  async markDone (category, refKey) {
    throw new Error('StateStore.markDone not implemented');
  }

  /**
   * Remove every ref in `category`. Called at the start of a fresh run to
   * discard stale work from a prior interrupted attempt that has been
   * subsumed by the new incremental threshold.
   * @param {string} category
   * @returns {Promise<void>}
   */
  async clearCategory (category) {
    throw new Error('StateStore.clearCategory not implemented');
  }

  // ─── Portable export / import ───

  /**
   * Serialize the store to a JSON-able snapshot. Refs are excluded by
   * design — they are per-run working data. The returned object has the
   * `sync-state.json` schema:
   *
   *   {
   *     format: 'pryv-account-backup-sync-state',
   *     formatVersion: 1,
   *     toolVersion: '<semver>',
   *     createdAt: '<ISO-8601>',
   *     kv: { ... }
   *   }
   *
   * @returns {Promise<object>}
   */
  async export () {
    throw new Error('StateStore.export not implemented');
  }

  /**
   * Replace the kv state from a prior `export()` snapshot. Refs are NOT
   * imported. The webapp calls this after the subject uploads a previously
   * downloaded `sync-state.json`.
   *
   * Throws if `data.format` doesn't match or `formatVersion` is unsupported.
   *
   * @param {object} data prior export() output
   * @returns {Promise<void>}
   */
  async import (data) {
    throw new Error('StateStore.import not implemented');
  }
}

StateStore.FORMAT = 'pryv-account-backup-sync-state';
StateStore.FORMAT_VERSION = 1;

module.exports = StateStore;
