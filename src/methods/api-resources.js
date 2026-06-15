/**
 * Streamed Pryv API resource → file writer.
 *
 * Pure isomorphic since v0.6.0:
 *   - HTTP: global `fetch` (Node 18+ + every modern browser),
 *   - disk: `writer.openWriteStream(relPath)` from a `StorageWriter` adapter.
 *
 * Callers MUST supply a `StorageWriter`. The Node CLI wraps a `BackupDirectory`
 * in `NodeFsStorageWriter` once (in `Backup.run`) and passes the writer to
 * this module — that keeps this file Node-free and browser-bundle-clean.
 *
 * @param params.writer       StorageWriter (required)
 * @param params.resource     Pryv API resource path, e.g. `events?modifiedSince=…`
 * @param params.connection   { endpoint, token }
 * @param params.extraFileName  optional suffix appended before `.json`
 * @param params.filename     optional full output filename (overrides derivation)
 * @param callback (err)
 * @param log optional log fn
 */
exports.toJSONFile = function streamApiToFile (params, callback, log) {
  if (!log) log = console.log;
  const connection = params.connection;
  const extraFileName = params.extraFileName || '';

  const writer = resolveWriter(params);
  const outputFilename = params.filename ||
    (params.resource.replace('/', '_').split('?')[0] + extraFileName + '.json');

  const target = (writer.describeTarget && writer.describeTarget()) || '';
  log('Fetching: ' + params.resource + extraFileName + (target ? ' in folder: ' + target : ''));

  const url = new URL(connection.endpoint);
  const base = url.protocol + '//' + url.host + url.pathname.replace(/\/$/, '');
  const fullUrl = base + '/' + params.resource;

  let total = 0;
  let done = false;
  const timeLog = function () {
    if (done) return;
    log('Fetching ' + outputFilename + ': ' + prettyPrint(total));
    setTimeout(timeLog, 1000);
  };
  setTimeout(timeLog, 1000);

  (async function () {
    const res = await fetch(fullUrl, {
      headers: { Authorization: connection.token }
    });
    if (res.status !== 200) {
      throw new Error('HTTP ' + res.status + ' ' + (res.statusText || '') +
        ' while fetching ' + fullUrl);
    }
    const writeStream = writer.openWriteStream(outputFilename);

    // res.body is a ReadableStream in both Node 18+ fetch and browser fetch.
    const reader = res.body.getReader();
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      total += value.byteLength;
      writeStream.write(value);
    }
    await endStream(writeStream);
    done = true;
    log('Received: ' + outputFilename + ' ' + prettyPrint(total));
  })().then(
    function () { callback(); },
    function (err) {
      if (!done) {
        done = true;
        log('Error while fetching ' + fullUrl + ': ' + (err.message || err));
      }
      callback(err);
    }
  );
};

function resolveWriter (params) {
  if (params.writer != null) return params.writer;
  throw new Error('api-resources.toJSONFile requires `writer`');
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

function prettyPrint (total) {
  if (total > 1000000) return Math.round(total / 1000000) + 'MB';
  if (total > 1000) return Math.round(total / 1000) + 'KB';
  return total + 'Bytes';
}
