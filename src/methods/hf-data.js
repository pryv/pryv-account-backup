const fs = require('fs');
const path = require('path');
const https = require('https');
const async = require('async');

/**
 * For every `series:*` event in `events.json`, fetch the data points via
 * `GET /events/<eventId>/series` and write them to
 * `<backupDir>/hf-data/<eventId>.json` (one file per series event).
 *
 * Earlier backup versions downloaded the series event "container" but never
 * fetched the actual data points, so a GDPR Art.15 portable dump was missing
 * the bulk of the user's data on any HFS-using deployment.
 *
 * @param {object} connection { endpoint, token } (pryv lib connection shape)
 * @param {object} backupDir BackupDirectory instance
 * @param {function} callback (err)
 * @param {function} [log] optional log function
 */
exports.download = function (connection, backupDir, callback, log) {
  if (!log) log = console.log;
  // Walk every event-data file the backup carries — legacy single-file
  // `events.json` (older backups) and chunked `events-YYYY-MM.json` (0.5.0+).
  // Prior to this fix, only the legacy file was inspected; chunked-only
  // backups silently skipped series-event discovery and produced an empty
  // hf-data/ folder, dropping the bulk of HFS-using subjects' data from the
  // Art.15 / Art.20 bundle.
  const eventFiles = (typeof backupDir.listEventFiles === 'function')
    ? backupDir.listEventFiles()
    : (fs.existsSync(backupDir.eventsFile) ? [backupDir.eventsFile] : []);
  if (eventFiles.length === 0) {
    log('hf-data: skipping (no events-*.json files — events fetch must run first)');
    return callback();
  }

  const seriesEvents = [];
  for (const file of eventFiles) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return callback(err);
    }
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    for (const e of events) {
      if (typeof e.type === 'string' && e.type.indexOf('series:') === 0) {
        seriesEvents.push(e);
      }
    }
  }

  if (seriesEvents.length === 0) {
    log('hf-data: no series events found, skipping');
    return callback();
  }

  log('hf-data: fetching data points for ' + seriesEvents.length + ' series event(s)');
  // Native fs.mkdir({recursive:true}) replaces mkdirp (which went ESM-only in v3).
  fs.promises.mkdir(backupDir.hfDataDir, { recursive: true }).then(function () {
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
