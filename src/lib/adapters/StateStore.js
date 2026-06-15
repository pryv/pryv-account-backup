/**
 * StateStore — interface for tracking incremental-backup progress.
 *
 * The library is consumed in two flavors:
 *   - CLI (Node): persists state to a sentinel file in the backup directory
 *     (FolderStateStore).
 *   - Browser: persists state to `localStorage` (LocalStorageStateStore, ships
 *     in the sample webapp).
 *
 * The orchestrator stores per-resource `lastModifiedSince` timestamps + run
 * metadata between sessions so a re-run picks up only what's new.
 *
 * Phase A: the interface is defined and a `MemoryStateStore` default exists
 * for tests. The CLI ships a `FolderStateStore`. The orchestrator does NOT
 * yet consume the state — Phase B wires it through the resource fetchers.
 *
 * @abstract
 */
class StateStore {
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
}

module.exports = StateStore;
