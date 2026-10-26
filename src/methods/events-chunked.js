/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
const apiResources = require('./api-resources');
const pager = require('./events-pager');

// Initial mode's probe range (incremental mode uses the wider bounds of
// events-pager: there they only filter, here they also seed the month windows).
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
 *   - INCREMENTAL run (`options.modifiedSince` provided): every event with
 *     `modified > T`, trashed ones included whatever `includeTrashed` says,
 *     and every deletion with `deleted > T` is fetched in explicit pages (see
 *     `events-pager`) and written to one `events-incremental-<RUN-TS>.json` as
 *     `{ events, eventDeletions, meta }`. Trashed events and deletions are
 *     included so restore applies them over the earlier copies.
 *
 * Both modes carry the standard `{ events: [...], meta: {...} }` response
 * shape and are individually hashable by the integrity manifest.
 *
 * @param connection { endpoint, token }
 * @param writerOrLegacy StorageWriter instance (preferred) or a BackupDirectory
 *                       (legacy v0.5.0 callers — auto-wrapped via the writer's
 *                       resolver in apiResources)
 * @param options
 *        options.includeTrashed {boolean}    initial mode: appends `&state=all`
 *                                            (incremental mode always does)
 *        options.modifiedSince  {number}     when present, switches to
 *                                            incremental mode
 *        options.runStartedAt   {number}     incremental run timestamp; used
 *                                            in the output filename
 *                                            (defaults to current epoch)
 *        options.fromTime {number}           initial-mode override
 *        options.toTime   {number}           initial-mode override
 *        options.chunkMonths {number}        initial-mode chunk size (default 1)
 *        options.incrementalPageSize {number} incremental-mode page size
 *                                            (default events-pager PAGE_SIZE)
 * @param callback (err)
 * @param log (msg)
 */
exports.download = function download (connection, writer, options, callback, log) {
  if (!log) log = console.log;
  if (writer == null || typeof writer.openWriteStream !== 'function') {
    throw new Error('events-chunked.download requires a StorageWriter');
  }
  options = options || {};
  const stateAll = options.includeTrashed ? '&state=all' : '';

  // onParsed lift: per-chunk JSON gets re-emitted as the events array. Lets
  // the orchestrator push attachment / series-event refs to the StateStore
  // without re-reading files post-fetch.
  const onEvents = typeof options.onEvents === 'function' ? options.onEvents : null;
  const onParsed = onEvents
    ? function (doc) { return onEvents(Array.isArray(doc.events) ? doc.events : []); }
    : null;

  // Incremental mode: paged fetch of everything modified / deleted since T.
  if (options.modifiedSince != null) {
    pager.toCallback(downloadIncremental(connection, writer, options, onEvents, log), callback);
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
        writer,
        resource,
        extraFileName: '-' + w.label,
        connection,
        onParsed
      }, function (err) {
        if (err) return callback(err);
        next();
      }, log);
    }
    next();
  });
};

/**
 * Incremental fetch: every changed event (trashed included, so a trash since
 * the last run reaches restore) and every deletion since
 * `options.modifiedSince`, read in pages by events-pager. Each page is written
 * to the file (and handed to `onEvents`) as it arrives, so memory does not grow
 * with the number of changes. A failed run closes the file as valid JSON marked
 * `"incomplete": true`; the run state is not advanced, so the next run reads the
 * same changes again into its own file.
 */
async function downloadIncremental (connection, writer, options, onEvents, log) {
  const since = options.modifiedSince;
  const runTs = options.runStartedAt || Math.floor(Date.now() / 1000);
  const pageOptions = { pageSize: options.incrementalPageSize };
  log('Events incremental: modifiedSince=' + since +
    ' (' + new Date(since * 1000).toISOString() + ')');

  const doc = pager.openJSONDocument(writer, 'events-incremental-' + runTs + '.json');
  let eventCount = 0;
  let deletionCount = 0;
  let meta = null;
  try {
    await doc.array('events');
    meta = await pager.walkEvents(connection, 'modifiedSince=' + since + '&state=all',
      Object.assign({ running: true }, pageOptions), async function (page) {
        await doc.items(page);
        eventCount += page.length;
        if (onEvents) {
          try {
            await onEvents(page);
          } catch (err) {
            // Ref collection is non-fatal: the events are in the file, a later
            // run can re-pick refs via modifiedSince.
            log('onEvents: skipped (' + (err.message || err) + ')');
          }
        }
      });
    await doc.array('eventDeletions');
    const deletionsMeta = await pager.walkDeletions(connection, since, pageOptions, async function (page) {
      await doc.items(page);
      deletionCount += page.length;
    });
    meta = meta || deletionsMeta;
  } catch (err) {
    await doc.closeIncomplete({ meta }, log);
    throw err;
  }
  log('Events incremental: ' + eventCount + ' event(s), ' + deletionCount + ' deletion(s)');
  await doc.close({ meta });
}

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
      callback(null, { from, to });
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
  pager.getJSON(connection, pathAndQuery).then(
    function (json) { callback(null, json); },
    function (err) { callback(err); }
  );
}

// Exported for unit tests.
exports._computeMonthlyWindows = computeMonthlyWindows;
exports._formatLabel = formatLabel;
exports.FAR_PAST = FAR_PAST;
exports.FAR_FUTURE = FAR_FUTURE;
exports.SECONDS_PER_DAY = SECONDS_PER_DAY;
