const async = require('async');

const CATEGORY = 'attachment';

/**
 * Download every binary attachment whose ref is queued under the
 * `attachment` category in the StateStore.
 *
 * Browser-isomorphic since v0.7.0:
 *   - HTTP: global `fetch`,
 *   - disk: `writer.openWriteStream('attachments/<eid>_<fileName>')`,
 *   - work queue: `stateStore.listPending('attachment')` populated by the
 *     orchestrator from the events stream via the `onParsed` hook.
 *
 * Per-attachment URL: `<apiEndpoint>events/<eid>/<attId>?readToken=<rt>`.
 * The response stream is piped chunk-by-chunk into the writer; no full-body
 * buffering, so multi-GB attachments stream through bounded memory in both
 * flavors. Each successful download is marked done in the store, so an
 * interrupted run resumes only the still-pending refs on the next attempt.
 *
 * Ref schema (pushed by the orchestrator):
 *   { key: '<eventId>:<attId>', eventId, attId, fileName, readToken }
 *
 * @param connection   { endpoint, token }
 * @param writer       StorageWriter
 * @param stateStore   StateStore (drains category 'attachment')
 * @param options      { concurrency?: number }   default 10 parallel downloads
 * @param callback     (err)
 * @param log          (msg)
 */
exports.download = function download (connection, writer, stateStore, options, callback, log) {
  if (!log) log = console.log;
  if (writer == null || typeof writer.openWriteStream !== 'function') {
    throw new Error('attachments.download requires a StorageWriter');
  }
  if (stateStore == null || typeof stateStore.listPending !== 'function') {
    throw new Error('attachments.download requires a StateStore');
  }
  options = options || {};
  const concurrency = options.concurrency || 10;

  (async function () {
    const refs = await stateStore.listPending(CATEGORY);
    if (refs.length === 0) {
      log('attachments: no pending attachments');
      return [];
    }
    log('attachments: downloading ' + refs.length + ' attachment(s)');
    return refs;
  })().then(function (refs) {
    if (refs.length === 0) return callback();
    async.mapLimit(refs, concurrency, function (att, done) {
      downloadOne(connection, writer, stateStore, att, log, done);
    }, function (err) {
      if (err) {
        log('attachments: failed — ' + (err.message || err));
        return callback(err);
      }
      log('attachments: done');
      callback();
    });
  }, callback);
};

function downloadOne (connection, writer, stateStore, att, log, callback) {
  const fileName = att.fileName || att.attId;
  const relPath = 'attachments/' + att.eventId + '_' + fileName;
  if (typeof writer.exists === 'function' && writer.exists(relPath)) {
    log('attachments: skipping existing ' + relPath);
    return stateStore.markDone(CATEGORY, att.key).then(
      function () { callback(); },
      callback
    );
  }
  const url = new URL(connection.endpoint);
  const base = url.protocol + '//' + url.host + url.pathname.replace(/\/$/, '');
  const fullUrl = base + '/events/' + encodeURIComponent(att.eventId) +
    '/' + encodeURIComponent(att.attId) +
    '?readToken=' + encodeURIComponent(att.readToken || '');

  (async function () {
    const res = await fetch(fullUrl);
    if (res.status !== 200) {
      throw new Error('HTTP ' + res.status + ' ' + (res.statusText || '') +
        ' while fetching ' + relPath);
    }
    const writeStream = writer.openWriteStream(relPath);
    const reader = res.body.getReader();
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      writeStream.write(value);
    }
    await endStream(writeStream);
    await stateStore.markDone(CATEGORY, att.key);
    log('attachments: wrote ' + relPath);
  })().then(
    function () { callback(); },
    function (err) {
      log('attachments: ' + relPath + ' — ' + (err.message || err));
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
