const fs = require('fs');
const path = require('path');
const https = require('https');
const async = require('async');
const mkdirp = require('mkdirp');

/**
 * For every `series:*` event in `events.json`, fetch the data points via
 * `GET /events/<eventId>/series` and write them to
 * `<backupDir>/hf-data/<eventId>.json` (one file per series event).
 *
 * Plan 72 Phase C.2: previously, the v0.2.3 backup downloaded the series
 * event "container" but never fetched the actual data points, so a
 * GDPR Art.15 portable dump was missing the bulk of the user's data on
 * any HFS-using deployment.
 *
 * @param {object} connection { endpoint, token } (pryv lib connection shape)
 * @param {object} backupDir BackupDirectory instance
 * @param {function} callback (err)
 * @param {function} [log] optional log function
 */
exports.download = function (connection, backupDir, callback, log) {
  if (!log) log = console.log;
  const eventsFile = backupDir.eventsFile;
  if (!fs.existsSync(eventsFile)) {
    log('hf-data: skipping (no events.json — events fetch must run first)');
    return callback();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
  } catch (err) {
    return callback(err);
  }
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const seriesEvents = events.filter(function (e) {
    return typeof e.type === 'string' && e.type.indexOf('series:') === 0;
  });

  if (seriesEvents.length === 0) {
    log('hf-data: no series events found, skipping');
    return callback();
  }

  log('hf-data: fetching data points for ' + seriesEvents.length + ' series event(s)');
  mkdirp(backupDir.hfDataDir).then(function () {
    async.mapLimit(seriesEvents, 4, function (event, done) {
      fetchOneSeries(connection, event.id, backupDir.hfDataDir, log, done);
    }, function (err) {
      if (err) return callback(err);
      log('hf-data: done');
      callback();
    });
  }).catch(callback);
};

function fetchOneSeries (connection, eventId, hfDataDir, log, callback) {
  const url = new URL(connection.endpoint);
  const resourcePath = url.pathname + 'events/' + eventId + '/series';
  const options = {
    host: url.hostname,
    port: url.port || 443,
    path: resourcePath,
    headers: { Authorization: connection.token }
  };
  const outFile = path.join(hfDataDir, eventId + '.json');
  const writeStream = fs.createWriteStream(outFile, { encoding: 'utf8' });
  let total = 0;
  let done = false;

  https.get(options, function (res) {
    if (res.statusCode !== 200) {
      done = true;
      writeStream.end();
      // 404 / 400 on an empty series is non-fatal — just log and skip.
      log('hf-data: skipping ' + eventId + ' (HTTP ' + res.statusCode + ')');
      try { fs.unlinkSync(outFile); } catch (_e) { /* ignore */ }
      return callback();
    }
    res.setEncoding('utf8');
    res.on('data', function (chunk) {
      total += chunk.length;
      writeStream.write(chunk);
    });
    res.on('end', function () {
      done = true;
      writeStream.end(function () {
        log('hf-data: ' + eventId + ' (' + total + ' bytes)');
        callback();
      });
    });
  }).on('error', function (e) {
    if (done) return;
    done = true;
    writeStream.end();
    log('hf-data: error fetching ' + eventId + ' — ' + e.message);
    callback(e);
  });
}
