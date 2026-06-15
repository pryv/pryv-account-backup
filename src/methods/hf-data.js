const async = require('async');

const CATEGORY = 'series-event';

/**
 * For every `series:*` event ref queued in the StateStore under the
 * `series-event` category, fetch its data points via
 * `GET /events/<eventId>/series` and write them to
 * `hf-data/<eventId>.json` (one file per series event).
 *
 * Earlier backup versions downloaded the series event "container" but never
 * fetched the actual data points, so a portable dump was missing the bulk of
 * the user's data on any HFS-using deployment.
 *
 * Browser-isomorphic since v0.7.0:
 *   - HTTP: global `fetch`,
 *   - disk: `writer.openWriteStream('hf-data/<eid>.json')`,
 *   - work queue: `stateStore.listPending('series-event')` populated by the
 *     orchestrator from the events stream via the `onParsed` hook.
 *
 * Ref schema (pushed by the orchestrator):
 *   { key: '<eventId>', eventId, type }
 *
 * @param {object} connection { endpoint, token }
 * @param {object} writer StorageWriter
 * @param {object} stateStore StateStore (drains category 'series-event')
 * @param {object} options { concurrency?: number } default 4
 * @param {function} callback (err)
 * @param {function} [log] optional log function
 */
exports.download = function download (connection, writer, stateStore, options, callback, log) {
  if (!log) log = console.log;
  if (writer == null || typeof writer.openWriteStream !== 'function') {
    throw new Error('hf-data.download requires a StorageWriter');
  }
  if (stateStore == null || typeof stateStore.listPending !== 'function') {
    throw new Error('hf-data.download requires a StateStore');
  }
  options = options || {};
  const concurrency = options.concurrency || 4;

  (async function () {
    const refs = await stateStore.listPending(CATEGORY);
    if (refs.length === 0) {
      log('hf-data: no pending series events, skipping');
      return [];
    }
    log('hf-data: fetching data points for ' + refs.length + ' series event(s)');
    return refs;
  })().then(function (refs) {
    if (refs.length === 0) return callback();
    async.mapLimit(refs, concurrency, function (ref, done) {
      fetchOneSeries(connection, writer, stateStore, ref, log, done);
    }, function (err) {
      if (err) return callback(err);
      log('hf-data: done');
      callback();
    });
  }, callback);
};

function fetchOneSeries (connection, writer, stateStore, ref, log, callback) {
  const eventId = ref.eventId;
  const url = new URL(connection.endpoint);
  const base = url.protocol + '//' + url.host + url.pathname.replace(/\/$/, '');
  const fullUrl = base + '/events/' + encodeURIComponent(eventId) + '/series';
  const relPath = 'hf-data/' + eventId + '.json';

  (async function () {
    const res = await fetch(fullUrl, {
      headers: { Authorization: connection.token }
    });
    if (res.status !== 200) {
      // 404 / 400 on an empty series is non-fatal — log + mark done so the
      // ref doesn't re-queue indefinitely on re-runs.
      log('hf-data: skipping ' + eventId + ' (HTTP ' + res.status + ')');
      await stateStore.markDone(CATEGORY, ref.key);
      return;
    }
    const writeStream = writer.openWriteStream(relPath);
    const reader = res.body.getReader();
    let total = 0;
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      total += value.byteLength;
      writeStream.write(value);
    }
    await endStream(writeStream);
    await stateStore.markDone(CATEGORY, ref.key);
    log('hf-data: ' + eventId + ' (' + total + ' bytes)');
  })().then(
    function () { callback(); },
    function (err) {
      log('hf-data: error fetching ' + eventId + ' — ' + (err.message || err));
      callback(err);
    }
  );
}

function endStream (writeStream) {
  return new Promise(function (resolve, reject) {
    if (typeof writeStream.end !== 'function') return resolve();
    try {
      writeStream.end(function (err) {
        if (err) return reject(err);
        resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

exports.CATEGORY = CATEGORY;
