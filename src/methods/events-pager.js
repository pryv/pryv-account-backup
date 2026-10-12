/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/**
 * Complete reads of `events.get`, page by page.
 *
 * `events.get` caps a query that has neither a time range nor a `limit` at 20
 * events (and its deletions at the same `limit`), so a bare `modifiedSince`
 * or `streams` request silently drops everything past the 20th row. Every
 * request here carries an explicit time range and `limit`.
 *
 * Paging is keyset-based rather than `skip`-based: the server sorts events by
 * `time` only (ties in no fixed order) and deletions by `deleted` only, and a
 * concurrent deletion would shift `skip` offsets and lose an unmodified event.
 * Each walk moves an inclusive bound instead, re-reads the rows sitting on the
 * bound, and de-duplicates by id; when a full page sits entirely on the bound
 * the page size doubles so ties of any size are read whole. A page longer than
 * `limit` means the server ignored the limit and sent the whole set: the walk
 * stops there.
 *
 * Isomorphic: global `fetch` only.
 */

const PAGE_SIZE = 1000;
// Wider than the initial mode's probe range: a changed event can carry any
// time, and these bounds only filter. Seconds; still a valid Date when a store
// converts them to milliseconds.
const FAR_PAST = -1e12;
const FAR_FUTURE = 1e12;

/**
 * Every event matching `query`, newest first.
 *
 * `toTime` is the moving inclusive cursor. Once it drops below "now" the server
 * stops matching running events (null `endTime`: `fromTime` filters on
 * `endTime`, and only lets null through while the range includes now), so with
 * `options.running` a second walk with `running=true` collects them.
 *
 * @param connection { endpoint, token }
 * @param {string} query  `events.get` parameters, URL-encoded, no leading `?`
 *                        (no fromTime / toTime / limit: the walk sets them)
 * @param {object} [options]
 * @param {number} [options.pageSize]
 * @param {boolean} [options.running]  also walk running events
 * @returns {Promise<{ events: object[], meta: object|null }>}
 */
async function collectEvents (connection, query, options) {
  options = options || {};
  const pageSize = options.pageSize || PAGE_SIZE;
  const seen = new Set();
  const events = [];
  let meta = null;
  const base = '/events?' + (query ? query + '&' : '') + 'fromTime=' + FAR_PAST;
  const walks = options.running ? ['', '&running=true'] : [''];
  for (const extra of walks) {
    let cursor = FAR_FUTURE;
    let limit = pageSize;
    while (true) {
      const res = await getJSON(connection, base + extra + '&toTime=' + cursor + '&limit=' + limit);
      meta = meta || res.meta || null;
      const page = Array.isArray(res.events) ? res.events : [];
      for (const e of page) {
        if (e == null || e.id == null || seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
      if (page.length !== limit) break;
      const lowest = page[page.length - 1].time;
      if (lowest < cursor) {
        cursor = lowest;
        limit = pageSize;
      } else {
        limit *= 2;
      }
    }
  }
  return { events, meta };
}

/**
 * Every event deletion with `deleted > since`.
 *
 * Walks oldest first with `modifiedSince` as the exclusive bound (the server
 * maps it to `deletedSince`) and a time range no event can match, so the event
 * half of those responses stays empty. Some engines ignore `limit` and the
 * order for deletions and return the whole set (`deleted >= since`, newest
 * first): the first response is then longer than `limit`, or a repeat of
 * itself, and the walk ends after one or two requests.
 *
 * @returns {Promise<{ eventDeletions: object[], meta: object|null }>}
 */
async function collectDeletions (connection, since, options) {
  options = options || {};
  const pageSize = options.pageSize || PAGE_SIZE;
  const seen = new Set();
  const eventDeletions = [];
  let meta = null;
  let bound = since;
  let limit = pageSize;
  while (true) {
    const res = await getJSON(connection, '/events?modifiedSince=' + bound +
      '&includeDeletions=true&sortAscending=true' +
      '&fromTime=' + (FAR_PAST - 2) + '&toTime=' + (FAR_PAST - 1) +
      '&limit=' + limit);
    meta = meta || res.meta || null;
    const page = Array.isArray(res.eventDeletions) ? res.eventDeletions : [];
    for (const d of page) {
      if (d == null || d.id == null || seen.has(d.id)) continue;
      seen.add(d.id);
      eventDeletions.push(d);
    }
    if (page.length !== limit) break;
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
  return { eventDeletions, meta };
}

/**
 * The server's clock (`meta.serverTime`, seconds), floored. Used as the next
 * incremental threshold so that a client clock ahead of the server cannot
 * skip changes made during the run. Returns `null` when the response carries
 * no `meta.serverTime`.
 */
async function serverTime (connection) {
  const res = await getJSON(connection, '/access-info');
  const t = res && res.meta && res.meta.serverTime;
  return typeof t === 'number' && isFinite(t) ? Math.floor(t) : null;
}

/**
 * Write `doc` as one JSON file through a StorageWriter.
 */
async function writeJSON (writer, relPath, doc) {
  const writeStream = writer.openWriteStream(relPath);
  writeStream.write(new TextEncoder().encode(JSON.stringify(doc)));
  await new Promise(function (resolve, reject) {
    if (typeof writeStream.end !== 'function') return resolve();
    writeStream.end(function (err) { return err ? reject(err) : resolve(); });
  });
}

/**
 * Run a promise-returning task and hand its outcome to a node-style callback
 * outside the promise chain, so an exception thrown by the caller is neither
 * swallowed nor turned into a second callback.
 */
function toCallback (promise, callback) {
  promise
    .then(function () { return null; }, function (err) { return err; })
    .then(function (err) {
      setTimeout(function () { err ? callback(err) : callback(); }, 0);
    });
}

// Isomorphic fetch-based JSON GET; not for streamed responses (those go
// through apiResources.toJSONFile).
async function getJSON (connection, pathAndQuery) {
  const url = new URL(connection.endpoint);
  const base = url.protocol + '//' + url.host + url.pathname.replace(/\/$/, '');
  const res = await fetch(base + pathAndQuery, {
    headers: { Authorization: connection.token }
  });
  if (res.status !== 200) {
    throw new Error('HTTP ' + res.status + ' ' + (res.statusText || '') + ' while fetching ' + pathAndQuery);
  }
  return await res.json();
}

module.exports = {
  PAGE_SIZE,
  FAR_PAST,
  FAR_FUTURE,
  collectEvents,
  collectDeletions,
  serverTime,
  writeJSON,
  toCallback,
  getJSON
};
