const fs = require('fs');
const https = require('https');
const async = require('async');

/**
 * For every access in `accesses.json`, call `GET /webhooks` with that access's
 * token and aggregate the result into `<backupDir>/webhooks.json` keyed by
 * accessId.
 *
 * Earlier backup versions never fetched webhooks at all, so the DSAR dump
 * was missing every webhook the subject had configured. Per-access fetch
 * matches the API's permissions model (each access only sees its own
 * webhooks; the personal access sees all).
 *
 * Output shape:
 *   {
 *     "generated_at": "<ISO>",
 *     "accesses_scanned": N,
 *     "webhooks": [ { ...webhook, accessId } ]
 *   }
 *
 * @param {object} connection { endpoint, token } (only used to derive the
 *   API host — the per-access token is what authenticates each request).
 * @param {object} backupDir BackupDirectory instance
 * @param {function} callback (err)
 * @param {function} [log] optional log function
 */
exports.download = function (connection, backupDir, callback, log) {
  if (!log) log = console.log;
  const accessesFile = backupDir.accessesFile;
  if (!fs.existsSync(accessesFile)) {
    log('webhooks-export: skipping (no accesses.json — accesses fetch must run first)');
    return callback();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(accessesFile, 'utf8'));
  } catch (err) {
    return callback(err);
  }
  const accesses = Array.isArray(parsed.accesses) ? parsed.accesses : [];
  // We only call /webhooks on accesses that actually carry a usable token.
  const scannable = accesses.filter(function (a) {
    return typeof a.token === 'string' && a.token.length > 0;
  });

  if (scannable.length === 0) {
    log('webhooks-export: no scannable accesses, skipping');
    return writeOutput(backupDir, scannable.length, [], log, callback);
  }

  log('webhooks-export: scanning ' + scannable.length + ' access(es)');
  const apiUrl = new URL(connection.endpoint);
  const collected = [];

  async.mapLimit(scannable, 4, function (access, done) {
    fetchWebhooksForAccess(apiUrl, access, log, function (err, list) {
      if (err) return done(err);
      list.forEach(function (w) {
        w.accessId = access.id;
        collected.push(w);
      });
      done();
    });
  }, function (err) {
    if (err) return callback(err);
    writeOutput(backupDir, scannable.length, collected, log, callback);
  });
};

function writeOutput (backupDir, accessesScanned, webhooks, log, callback) {
  const out = {
    generated_at: new Date().toISOString(),
    accesses_scanned: accessesScanned,
    webhooks
  };
  fs.writeFile(backupDir.webhooksFile, JSON.stringify(out, null, 2), 'utf8', function (err) {
    if (err) return callback(err);
    log('webhooks-export: wrote ' + webhooks.length + ' webhook(s) to ' + backupDir.webhooksFile);
    callback();
  });
}

function fetchWebhooksForAccess (apiUrl, access, log, callback) {
  // Pick http or https based on the apiEndpoint scheme — required for
  // dev / lab deployments that run HTTP-only (the QuickStart on mbp2,
  // CI fixtures, etc.). Production always uses https.
  const transport = apiUrl.protocol === 'http:' ? require('http') : https;
  const options = {
    host: apiUrl.hostname,
    port: apiUrl.port || (apiUrl.protocol === 'http:' ? 80 : 443),
    path: apiUrl.pathname + 'webhooks',
    headers: { Authorization: access.token }
  };
  const chunks = [];
  transport.get(options, function (res) {
    if (res.statusCode === 401 || res.statusCode === 403) {
      // Expected for expired tokens — skip silently.
      log('webhooks-export: access ' + access.id + ' rejected (HTTP ' + res.statusCode + '), skipping');
      return callback(null, []);
    }
    if (res.statusCode !== 200) {
      log('webhooks-export: access ' + access.id + ' returned HTTP ' + res.statusCode + ', skipping');
      return callback(null, []);
    }
    res.setEncoding('utf8');
    res.on('data', (c) => chunks.push(c));
    res.on('end', function () {
      let body;
      try {
        body = JSON.parse(chunks.join(''));
      } catch (parseErr) {
        log('webhooks-export: access ' + access.id + ' returned unparseable body, skipping');
        return callback(null, []);
      }
      const list = Array.isArray(body.webhooks) ? body.webhooks : [];
      callback(null, list);
    });
  }).on('error', function (e) {
    log('webhooks-export: access ' + access.id + ' transport error — ' + e.message);
    callback(null, []); // non-fatal — keep going for the rest of accesses
  });
}
