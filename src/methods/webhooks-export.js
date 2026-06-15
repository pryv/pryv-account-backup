const async = require('async');

const CATEGORY = 'webhook';

/**
 * For every access ref queued in the StateStore under the `webhook` category,
 * call `GET /webhooks` with that access's token and aggregate the result into
 * `<baseDir>/webhooks.json` keyed by accessId.
 *
 * Earlier backup versions never fetched webhooks at all, so the disclosure
 * was missing every webhook the subject had configured. Per-access fetch
 * matches the API's permissions model (each access only sees its own
 * webhooks; the personal access sees all).
 *
 * Browser-isomorphic since v0.7.0:
 *   - HTTP: global `fetch` (uniform handling of http vs https),
 *   - disk: `writer.openWriteStream('webhooks.json')`,
 *   - work queue: `stateStore.listPending('webhook')` populated by the
 *     orchestrator from the accesses payload via the `onParsed` hook.
 *
 * Ref schema (pushed by the orchestrator):
 *   { key: '<accessId>', accessId, token, type }
 *
 * Output shape:
 *   {
 *     "generated_at": "<ISO>",
 *     "accesses_scanned": N,
 *     "webhooks": [ { ...webhook, accessId } ]
 *   }
 *
 * @param {object} connection { endpoint, token }
 * @param {object} writer StorageWriter
 * @param {object} stateStore StateStore (drains category 'webhook')
 * @param {object} options { concurrency?: number } default 4
 * @param {function} callback (err)
 * @param {function} [log] optional log function
 */
exports.download = function download (connection, writer, stateStore, options, callback, log) {
  if (!log) log = console.log;
  if (writer == null || typeof writer.openWriteStream !== 'function') {
    throw new Error('webhooks-export.download requires a StorageWriter');
  }
  if (stateStore == null || typeof stateStore.listPending !== 'function') {
    throw new Error('webhooks-export.download requires a StateStore');
  }
  options = options || {};
  const concurrency = options.concurrency || 4;

  (async function () {
    const refs = await stateStore.listPending(CATEGORY);
    if (refs.length === 0) {
      log('webhooks-export: no scannable accesses, writing empty bundle');
      return [];
    }
    log('webhooks-export: scanning ' + refs.length + ' access(es)');
    return refs;
  })().then(function (refs) {
    const apiUrl = new URL(connection.endpoint);
    const collected = [];

    async.mapLimit(refs, concurrency, function (ref, done) {
      fetchWebhooksForAccess(apiUrl, ref, log, function (err, list) {
        if (err) return done(err);
        list.forEach(function (w) {
          w.accessId = ref.accessId;
          collected.push(w);
        });
        stateStore.markDone(CATEGORY, ref.key).then(function () { done(); }, done);
      });
    }, function (err) {
      if (err) return callback(err);
      writeOutput(writer, refs.length, collected, log, callback);
    });
  }, callback);
};

function writeOutput (writer, accessesScanned, webhooks, log, callback) {
  const out = {
    generated_at: new Date().toISOString(),
    accesses_scanned: accessesScanned,
    webhooks: webhooks
  };
  const writeStream = writer.openWriteStream('webhooks.json');
  writeStream.write(JSON.stringify(out, null, 2));
  if (typeof writeStream.end === 'function') {
    writeStream.end(function (err) {
      if (err) return callback(err);
      log('webhooks-export: wrote ' + webhooks.length + ' webhook(s) to webhooks.json');
      callback();
    });
  } else {
    log('webhooks-export: wrote ' + webhooks.length + ' webhook(s) to webhooks.json');
    callback();
  }
}

function fetchWebhooksForAccess (apiUrl, ref, log, callback) {
  const base = apiUrl.protocol + '//' + apiUrl.host + apiUrl.pathname.replace(/\/$/, '');
  const fullUrl = base + '/webhooks';
  (async function () {
    const res = await fetch(fullUrl, {
      headers: { Authorization: ref.token }
    });
    if (res.status === 401 || res.status === 403) {
      // Expected for expired tokens — skip silently.
      log('webhooks-export: access ' + ref.accessId + ' rejected (HTTP ' + res.status + '), skipping');
      return [];
    }
    if (res.status !== 200) {
      log('webhooks-export: access ' + ref.accessId + ' returned HTTP ' + res.status + ', skipping');
      return [];
    }
    let body;
    try {
      body = await res.json();
    } catch (parseErr) {
      log('webhooks-export: access ' + ref.accessId + ' returned unparseable body, skipping');
      return [];
    }
    return Array.isArray(body.webhooks) ? body.webhooks : [];
  })().then(
    function (list) { callback(null, list); },
    function (e) {
      log('webhooks-export: access ' + ref.accessId + ' transport error — ' + (e.message || e));
      callback(null, []); // non-fatal — keep going for the rest of accesses
    }
  );
}

exports.CATEGORY = CATEGORY;
