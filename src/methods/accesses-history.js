const fs = require('fs');
const path = require('path');
const apiResources = require('./api-resources');

/**
 * Fetch per-access version history for every access listed in `accesses.json`.
 *
 * Each access is queried with `GET /accesses/<id>?includeHistory=true`, which
 * returns `{ access, history, current }`. Written one file per access at
 * `accesses-history/<accessId>.json`. Useful when an Art.15(1)(a) DSAR needs
 * the consent-state-at-time-of-access provenance trail beyond what
 * `accesses-all.json` (current + deletions + expired) carries.
 *
 * This is O(N) in the access count; opt-in only.
 *
 * @param connection { endpoint, token }
 * @param backupDirectory BackupDirectory instance
 * @param callback (err)
 * @param log (msg)
 */
exports.download = function download (connection, backupDirectory, callback, log) {
  if (!log) log = console.log;

  if (!fs.existsSync(backupDirectory.accessesFile)) {
    log('No accesses.json present — skipping per-access history.');
    return callback();
  }

  let accessesData;
  try {
    accessesData = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
  } catch (err) {
    return callback(err);
  }
  const accesses = Array.isArray(accessesData.accesses) ? accessesData.accesses : [];
  if (accesses.length === 0) {
    log('No accesses to walk for version history.');
    return callback();
  }

  // Output dir
  try {
    fs.mkdirSync(backupDirectory.accessesHistoryDir, { recursive: true });
  } catch (err) {
    return callback(err);
  }

  log('Fetching per-access version history for ' + accesses.length + ' access(es).');

  let i = 0;
  function next () {
    if (i >= accesses.length) return callback();
    const access = accesses[i++];
    const accessId = access && access.id;
    if (!accessId) return next();
    // Access ids in the wire format are `<base>:<serial>` composite refs; the
    // accesses.getOne endpoint accepts either the composite or the base. Use
    // the composite as-is so the history call lands on the same head row.
    apiResources.toJSONFile({
      folder: backupDirectory.accessesHistoryDir,
      resource: 'accesses/' + encodeURIComponent(accessId) + '?includeHistory=true',
      // api-resources derives the filename by replacing '/' with '_' and
      // stripping the '?…' suffix, so this yields `accesses_<accessId>.json`
      // — collapse to just `<accessId>.json` via extraFileName override below.
      extraFileName: '',
      connection: connection,
      filename: encodeURIComponent(accessId) + '.json'
    }, function (err) {
      if (err) {
        // Log + continue — one failed access shouldn't abort the whole walk.
        log('Failed to fetch history for access ' + accessId + ': ' + err);
      }
      next();
    }, log);
  }
  next();
};
