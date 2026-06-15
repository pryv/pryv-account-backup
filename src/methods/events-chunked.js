const https = require('https');
const apiResources = require('./api-resources');

const FAR_PAST = -2350373077;
const FAR_FUTURE = 2350373077;
const SECONDS_PER_DAY = 86400;

/**
 * Fetch events in one of two modes depending on `options.modifiedSince`:
 *
 *   - INITIAL run (no prior state, no `modifiedSince`): chunked time-range
 *     fetch. Probe the subject's discovered event-time range with two
 *     `limit=1` calls, slice into UTC-month windows, write one
 *     `events-YYYY-MM.json` per window. For multi-GB subjects this avoids
 *     timing out the single round-trip + OOMing the caller. Preserved from
 *     v0.5.0.
 *
 *   - INCREMENTAL run (`options.modifiedSince` provided): single
 *     `events?modifiedSince=T&includeDeletions=true` round-trip writes
 *     `events-incremental-<RUN-TS>.json`. Only events with
 *     `modified > T` flow over the wire — minimum bytes; deletions are
 *     included so deletion-aware restore consumers can reconstruct.
 *
 * Both modes carry the standard `{ events: [...], meta: {...} }` response
 * shape and are individually hashable by the integrity manifest.
 *
 * @param connection { endpoint, token }
 * @param backupDirectory BackupDirectory instance (provides baseDir)
 * @param options
 *        options.includeTrashed {boolean}    appends `&state=all`
 *        options.modifiedSince  {number}     when present, switches to
 *                                            incremental mode
 *        options.runStartedAt   {number}     incremental run timestamp; used
 *                                            in the output filename
 *                                            (defaults to current epoch)
 *        options.fromTime {number}           initial-mode override
 *        options.toTime   {number}           initial-mode override
 *        options.chunkMonths {number}        initial-mode chunk size (default 1)
 * @param callback (err)
 * @param log (msg)
 */
exports.download = function download (connection, backupDirectory, options, callback, log) {
  if (!log) log = console.log;
  options = options || {};
  const stateAll = options.includeTrashed ? '&state=all' : '';

  // Incremental mode: single round-trip with modifiedSince.
  if (options.modifiedSince != null) {
    const runTs = options.runStartedAt || Math.floor(Date.now() / 1000);
    const resource = 'events?modifiedSince=' + options.modifiedSince +
      '&includeDeletions=true' + stateAll;
    log('Events incremental: modifiedSince=' + options.modifiedSince +
      ' (' + new Date(options.modifiedSince * 1000).toISOString() + ')');
    apiResources.toJSONFile({
      folder: backupDirectory.baseDir,
      resource: resource,
      connection: connection,
      filename: 'events-incremental-' + runTs + '.json'
    }, callback, log);
    return;
  }

  // Initial mode: probe + chunked time-range.
  const chunkMonths = options.chunkMonths || 1;
  probeRange(connection, stateAll, options, log, function (probeErr, range) {
    if (probeErr) return callback(probeErr);
    if (range == null) {
      log('No events found in subject account — skipping chunked events fetch.');
      return callback();
    }

    const windows = computeMonthlyWindows(range.from, range.to, chunkMonths);
    log('Events range: ' + new Date(range.from * 1000).toISOString() +
      ' → ' + new Date(range.to * 1000).toISOString() +
      ' (' + windows.length + ' window(s) of ' + chunkMonths + ' month(s))');

    let i = 0;
    function next () {
      if (i >= windows.length) return callback();
      const w = windows[i++];
      const resource = 'events?fromTime=' + w.from + '&toTime=' + w.to + stateAll;
      // api-resources.toJSONFile derives the filename by stripping `?…` from
      // the resource string, so passing the full query yields `events-YYYY-MM.json`.
      apiResources.toJSONFile({
        folder: backupDirectory.baseDir,
        resource: resource,
        extraFileName: '-' + w.label,
        connection: connection
      }, function (err) {
        if (err) return callback(err);
        next();
      }, log);
    }
    next();
  });
};

/**
 * Discover the earliest + latest event timestamp on the subject account.
 * Returns `{ from, to }` (seconds-since-epoch) or `null` when the subject has
 * zero events.
 *
 * Uses 1-event probes — sortAscending=true for the floor, default desc for
 * the ceiling. Honors `options.fromTime` / `options.toTime` overrides without
 * probing when both are supplied.
 */
function probeRange (connection, stateAll, options, log, callback) {
  if (options.fromTime != null && options.toTime != null) {
    return callback(null, { from: options.fromTime, to: options.toTime });
  }

  const baseRange = 'fromTime=' + FAR_PAST + '&toTime=' + FAR_FUTURE + stateAll;
  apiGet(connection, '/events?limit=1&sortAscending=true&' + baseRange, function (err, earliest) {
    if (err) return callback(err);
    if (!earliest || !earliest.events || earliest.events.length === 0) {
      return callback(null, null);
    }
    apiGet(connection, '/events?limit=1&' + baseRange, function (err2, latest) {
      if (err2) return callback(err2);
      const from = (options.fromTime != null) ? options.fromTime : earliest.events[0].time;
      const to = (options.toTime != null) ? options.toTime : latest.events[0].time;
      callback(null, { from: from, to: to });
    });
  });
}

/**
 * Slice [from, to] into UTC-month-aligned windows.
 * Windows are half-open `[from, to)` on the seconds axis except the last,
 * which is closed at `to`. Empty windows are still emitted — the API call
 * happily returns `events: []` and the manifest hashes the empty file. (The
 * caller can choose to skip-on-empty in a later pass; for now we keep it
 * simple and predictable.)
 */
function computeMonthlyWindows (fromSec, toSec, chunkMonths) {
  const fromMs = fromSec * 1000;
  const toMs = toSec * 1000;
  const start = new Date(fromMs);
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);

  const windows = [];
  let cursorMs = startUtc;
  while (cursorMs <= toMs) {
    const cursor = new Date(cursorMs);
    const nextMs = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + chunkMonths, 1);
    const windowFromSec = Math.max(Math.floor(cursorMs / 1000), fromSec);
    const windowToSec = Math.min(Math.floor(nextMs / 1000) - 1, toSec);
    if (windowFromSec > windowToSec) {
      cursorMs = nextMs;
      continue;
    }
    windows.push({
      from: windowFromSec,
      to: windowToSec,
      label: formatLabel(cursor)
    });
    cursorMs = nextMs;
  }
  // Guarantee at least one window when from == to (single-instant subject).
  if (windows.length === 0) {
    windows.push({ from: fromSec, to: toSec, label: formatLabel(new Date(fromMs)) });
  }
  return windows;
}

function formatLabel (date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

function apiGet (connection, pathAndQuery, callback) {
  const url = new URL(connection.endpoint);
  const fullPath = url.pathname.replace(/\/$/, '') + pathAndQuery;
  const opts = {
    host: url.hostname,
    port: url.port || 443,
    path: fullPath,
    headers: { Authorization: connection.token }
  };
  https.get(opts, function (res) {
    if (res.statusCode !== 200) {
      return callback(new Error('Probe failed: ' + res.statusCode + ' ' + res.statusMessage));
    }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      try { callback(null, JSON.parse(body)); } catch (e) { callback(e); }
    });
  }).on('error', callback);
}

// Exported for unit tests.
exports._computeMonthlyWindows = computeMonthlyWindows;
exports._formatLabel = formatLabel;
exports.FAR_PAST = FAR_PAST;
exports.FAR_FUTURE = FAR_FUTURE;
exports.SECONDS_PER_DAY = SECONDS_PER_DAY;
