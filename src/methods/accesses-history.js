const apiResources = require('./api-resources');

/**
 * Fetch per-access version history for every access supplied. Each access is
 * queried with `GET /accesses/<id>?includeHistory=true` and written to
 * `accesses-history/<accessId>.json`.
 *
 * Used when an Art.15(1)(a) DSAR needs the consent-state-at-time-of-access
 * provenance trail beyond what `accesses-all.json` (current + deletions +
 * expired) carries.
 *
 * O(N) in the access count; opt-in only.
 *
 * @param connection { endpoint, token }
 * @param writerOrLegacy  StorageWriter (preferred) or a BackupDirectory
 * @param accessesArray   array of accesses from `accesses.json`; passed by the
 *                        orchestrator so this module doesn't need to read disk
 *                        (browser flavor: same array, in-memory). Legacy
 *                        callers may pass `null` and rely on the
 *                        BackupDirectory's `accessesFile` — kept for v0.5.0
 *                        back-compat only.
 * @param callback (err)
 * @param log (msg)
 */
exports.download = function download (connection, writer, accessesArray, callback, log) {
  if (!log) log = console.log;
  if (writer == null || typeof writer.openWriteStream !== 'function') {
    throw new Error('accesses-history.download requires a StorageWriter');
  }
  if (!Array.isArray(accessesArray)) {
    throw new Error('accesses-history.download requires an accessesArray (use Backup orchestrator for the legacy CLI path)');
  }

  if (accessesArray.length === 0) {
    log('No accesses to walk for version history.');
    return callback();
  }

  log('Fetching per-access version history for ' + accessesArray.length + ' access(es).');

  let i = 0;
  function next () {
    if (i >= accessesArray.length) return callback();
    const access = accessesArray[i++];
    const accessId = access && access.id;
    if (!accessId) return next();
    apiResources.toJSONFile({
      writer: writer,
      resource: 'accesses/' + encodeURIComponent(accessId) + '?includeHistory=true',
      connection: connection,
      filename: 'accesses-history/' + encodeURIComponent(accessId) + '.json'
    }, function (err) {
      if (err) {
        log('Failed to fetch history for access ' + accessId + ': ' + err);
      }
      next();
    }, log);
  }
  next();
};
