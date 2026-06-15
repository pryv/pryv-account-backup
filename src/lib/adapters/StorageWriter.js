/**
 * StorageWriter — interface for writing backup files.
 *
 * The library is consumed in two flavors:
 *   - CLI (Node): writes directly to a directory on disk.
 *   - Browser: composes files into in-memory ZIPs, finalized + downloaded
 *     when a size threshold is crossed.
 *
 * Per-resource modules consume a `StorageWriter` instance for all I/O so the
 * same fetch + state-track logic can drive either flavor.
 *
 * Implementations: see `NodeFsStorageWriter` (CLI). The browser implementation
 * ships in the sample webapp in a separate repository.
 *
 * @abstract
 */
class StorageWriter {
  /**
   * Open a writable stream at a relative path. Used for streamed writes —
   * primarily JSON resources fetched via HTTPS streaming + binary attachments
   * piped from upstream responses.
   *
   * The returned stream has the standard Node `Writable` shape: `write(chunk)`,
   * `end(cb?)`. Browser implementations adapt by buffering into a `Blob`
   * fragment per-stream and committing on `end()`.
   *
   * @param {string} relPath  e.g. `events-2024-01.json`, `attachments/<eid>_foo.bin`
   * @returns {NodeJS.WritableStream}
   */
  openWriteStream (relPath) {
    throw new Error('StorageWriter.openWriteStream not implemented');
  }

  /**
   * Whether a file already exists at the given relative path. Used for
   * incremental skip-if-present (binaries) and for the chunked-event-file
   * skip-on-rerun check.
   *
   * @param {string} relPath
   * @returns {boolean}
   */
  exists (relPath) {
    throw new Error('StorageWriter.exists not implemented');
  }

  /**
   * Web flavor: finalize the current accumulating ZIP and trigger a download.
   * CLI: no-op (each `openWriteStream` already commits to disk).
   *
   * Called by the orchestrator between resource boundaries OR when the
   * accumulated buffer crosses a size threshold (Web only).
   *
   * @returns {Promise<void>}
   */
  async finalizeBatch () {
    // CLI default: no-op.
  }

  /**
   * Human-readable description of where output lands. Used for log output
   * ("Backing up to: …") and for the existing `BackupDirectory#baseDir`
   * compatibility shim.
   *
   * @returns {string}
   */
  describeTarget () {
    throw new Error('StorageWriter.describeTarget not implemented');
  }
}

module.exports = StorageWriter;
