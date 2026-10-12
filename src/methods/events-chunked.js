/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
const apiResources = require('./api-resources');

const FAR_PAST = -2350373077;
const FAR_FUTURE = 2350373077;
const SECONDS_PER_DAY = 86400;
// Incremental mode: page size, and a time range wide enough for any event
// (seconds; stays a valid Date when a store converts it to milliseconds).
const INCREMENTAL_PAGE_SIZE = 1000;
const INCREMENTAL_FAR_PAST = -1e12;
const INCREMENTAL_FAR_FUTURE = 1e12;

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
 *     `modified > T` and every deletion with `deleted > T` is fetched in
 *     explicit pages (see `downloadIncremental`) and written to one
 *     `events-incremental-<RUN-TS>.json` as `{ events, eventDeletions, meta }`.
 *     Deletions are included so deletion-aware restore consumers can
 *     reconstruct.
 *
 * Both modes carry the standard `{ events: [...], meta: {...} }` response
 * shape and are individually hashable by the integrity manifest.
 *
 * @param connection { endpoint, token }
 * @param writerOrLegacy StorageWriter instance (preferred) or a BackupDirectory
 *                       (legacy v0.5.0 callers — auto-wrapped via the writer's
 *                       resolver in apiResources)
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
    // The callback runs outside the promise chain so an exception thrown by
    // the caller is neither swallowed nor turned into a second callback.
    downloadIncremental(connection, writer, options, stateAll, onEvents, log)
      .then(function () { return null; }, function (err) { return err; })
      .then(function (err) {
        setTimeout(function () { err ? callback(err) : callback(); }, 0);
      });
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
        writer: writer,
        resource: resource,
        extraFileName: '-' + w.label,
        connection: connection,
        onParsed: onParsed
      }, function (err) {
        if (err) return callback(err);
        next();
      }, log);
    }
    next();
  });
};

/**
 * Incremental fetch. `events.get` caps a query that has neither a time range
 * nor a `limit` at 20 events (and its deletions at the same `limit`), so a
 * bare `modifiedSince` request silently drops everything past the 20th
 * change. Every request here carries an explicit time range and `limit`.
 *
 * Paging is keyset-based rather than `skip`-based: the server sorts events by
 * `time` only (ties in no fixed order) and deletions by `deleted` only, and a
 * concurrent deletion would shift `skip` offsets and lose an unmodified event.
 * Each loop moves an inclusive bound instead, re-reads the rows sitting on the
 * bound, and de-duplicates by id; when a full page sits entirely on the bound
 * the page size doubles so ties of any size are read whole.
 *
 *   1. Events, newest first, `toTime` = cursor (inclusive). Once the cursor
 *      drops below "now" the server stops matching running events (null
 *      `endTime`), so:
 *   2. running events get the same walk with `running=true`.
 *   3. Deletions, oldest first, with `modifiedSince` as the exclusive bound
 *      (deletions are matched on `deleted > modifiedSince`, ordered by
 *      `deleted`) and a time range no event can match, so the event half of
 *      those responses stays empty.
 *
 * The file is written once, after every page has been read, so a failed run
 * never leaves a truncated JSON document behind.
 */
async function downloadIncremental (connection, writer, options, stateAll, onEvents, log) {
  log = log || function () {};
  const since = options.modifiedSince;
  const runTs = options.runStartedAt || Math.floor(Date.now() / 1000);
  const pageSize = options.incrementalPageSize || INCREMENTAL_PAGE_SIZE;
  log('Events incremental: modifiedSince=' + since +
    ' (' + new Date(since * 1000).toISOString() + ')');

  const seenEvents = new Set();
  const events = [];
  let meta = null;
  function keepEvents (list) {
    for (const e of list) {
      if (e == null || e.id == null || seenEvents.has(e.id)) continue;
      seenEvents.add(e.id);
      events.push(e);
    }
  }

  const eventsBase = '/events?modifiedSince=' + since +
    '&fromTime=' + INCREMENTAL_FAR_PAST + stateAll;
  for (const extra of ['', '&running=true']) {
    let cursor = INCREMENTAL_FAR_FUTURE;
    let limit = pageSize;
    while (true) {
      const res = await apiGetAsync(connection, eventsBase + extra +
        '&toTime=' + cursor + '&limit=' + limit);
      meta = res.meta || meta;
      const page = Array.isArray(res.events) ? res.events : [];
      keepEvents(page);
      if (page.length < limit) break;
      const lowest = page[page.length - 1].time;
      if (lowest < cursor) {
        cursor = lowest;
        limit = pageSize;
      } else {
        limit *= 2;
      }
    }
  }

  const seenDeletions = new Set();
  const eventDeletions = [];
  let bound = since;
  let limit = pageSize;
  while (true) {
    const res = await apiGetAsync(connection, '/events?modifiedSince=' + bound +
      '&includeDeletions=true&sortAscending=true' +
      '&fromTime=' + (INCREMENTAL_FAR_PAST - 2) + '&toTime=' + (INCREMENTAL_FAR_PAST - 1) +
      '&limit=' + limit);
    meta = res.meta || meta;
    const page = Array.isArray(res.eventDeletions) ? res.eventDeletions : [];
    for (const d of page) {
      if (d == null || d.id == null || seenDeletions.has(d.id)) continue;
      seenDeletions.add(d.id);
      eventDeletions.push(d);
    }
    if (page.length < limit) break;
    // Largest `deleted` strictly below the last one: rows on the last value
    // are read again by the next request.
    const last = page[page.length - 1].deleted;
    let below = null;
    for (const d of page) {
      if (d.deleted < last && (below == null || d.deleted > below)) below = d.deleted;
    }
    if (below != null && below > bound) {
      bound = below;
      limit = pageSize;
    } else {
      limit *= 2;
    }
  }

  log('Events incremental: ' + events.length + ' event(s), ' +
    eventDeletions.length + ' deletion(s)');
  const doc = { events, eventDeletions };
  if (meta) doc.meta = meta;
  const writeStream = writer.openWriteStream('events-incremental-' + runTs + '.json');
  writeStream.write(new TextEncoder().encode(JSON.stringify(doc)));
  await new Promise(function (resolve, reject) {
    if (typeof writeStream.end !== 'function') return resolve();
    writeStream.end(function (err) { return err ? reject(err) : resolve(); });
  });
  if (onEvents) {
    try {
      await onEvents(events);
    } catch (err) {
      // Ref collection is non-fatal: the file is on disk, a later run can
      // re-pick refs via modifiedSince.
      log('onEvents: skipped (' + (err.message || err) + ')');
    }
  }
}

function apiGetAsync (connection, pathAndQuery) {
  return new Promise(function (resolve, reject) {
    apiGet(connection, pathAndQuery, function (err, json) {
      return err ? reject(err) : resolve(json);
    });
  });
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

// Isomorphic fetch-based JSON GET. Used for the limit=1 probes and the
// incremental pages; not for streamed responses (those go through
// apiResources.toJSONFile).
function apiGet (connection, pathAndQuery, callback) {
  const url = new URL(connection.endpoint);
  const base = url.protocol + '//' + url.host + url.pathname.replace(/\/$/, '');
  const fullUrl = base + pathAndQuery;
  (async function () {
    const res = await fetch(fullUrl, {
      headers: { Authorization: connection.token }
    });
    if (res.status !== 200) {
      throw new Error('HTTP ' + res.status + ' ' + (res.statusText || '') + ' while fetching ' + pathAndQuery);
    }
    return await res.json();
  })().then(
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
exports.INCREMENTAL_PAGE_SIZE = INCREMENTAL_PAGE_SIZE;
