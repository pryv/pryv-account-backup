const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const async = require('async');

const MANIFEST_FILENAME = 'manifest.json';
const ALGORITHM = 'sha256';

/**
 * Walks `rootDir` recursively, computes a sha256 of every regular file (other
 * than the manifest itself), and writes the manifest to `<rootDir>/manifest.json`.
 *
 * The manifest is the integrity hash referenced in Plan 72 Phase C — a third
 * party reading the backup tarball can re-hash each file and compare to detect
 * truncation, corruption, or tampering mid-flight.
 *
 * @param {string} rootDir absolute backup directory (the one containing
 *   events.json, streams.json, ...).
 * @param {object} [opts]
 * @param {string} [opts.version] tool version stamped into the manifest.
 * @param {function} [opts.log] log function (defaults to console.log).
 * @param {function} callback (err, manifestPath)
 */
exports.generate = function (rootDir, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts = opts || {};
  const log = opts.log || console.log;
  const manifestPath = path.join(rootDir, MANIFEST_FILENAME);

  walk(rootDir, function (err, files) {
    if (err) return callback(err);
    // Exclude the manifest itself (we're about to overwrite it).
    files = files.filter((f) => path.basename(f) !== MANIFEST_FILENAME);

    async.mapLimit(files, 4, function (absPath, done) {
      hashFile(absPath, function (err2, digest) {
        if (err2) return done(err2);
        done(null, { rel: path.relative(rootDir, absPath), digest });
      });
    }, function (err3, results) {
      if (err3) return callback(err3);
      const filesMap = {};
      results.forEach(function (r) { filesMap[r.rel] = r.digest; });
      const manifest = {
        algorithm: ALGORITHM,
        version: opts.version || null,
        generated_at: new Date().toISOString(),
        file_count: results.length,
        files: filesMap
      };
      fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8', function (err4) {
        if (err4) return callback(err4);
        log('Wrote integrity manifest: ' + manifestPath + ' (' + results.length + ' files)');
        callback(null, manifestPath);
      });
    });
  });
};

/**
 * Re-hash every file listed in `<rootDir>/manifest.json` and report mismatches.
 * Use this from a restore-side preflight or from any third-party DSAR auditor.
 *
 * @param {string} rootDir
 * @param {function} callback (err, { ok: boolean, mismatches: string[], missing: string[], extra: string[] })
 */
exports.verify = function (rootDir, callback) {
  const manifestPath = path.join(rootDir, MANIFEST_FILENAME);
  fs.readFile(manifestPath, 'utf8', function (err, raw) {
    if (err) return callback(err);
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (parseErr) {
      return callback(parseErr);
    }
    walk(rootDir, function (err2, onDisk) {
      if (err2) return callback(err2);
      const onDiskRel = onDisk
        .map((f) => path.relative(rootDir, f))
        .filter((rel) => rel !== MANIFEST_FILENAME);
      const expectedRel = Object.keys(manifest.files);
      const missing = expectedRel.filter((r) => !onDiskRel.includes(r));
      const extra = onDiskRel.filter((r) => !expectedRel.includes(r));
      async.mapLimit(expectedRel.filter((r) => onDiskRel.includes(r)), 4, function (rel, done) {
        hashFile(path.join(rootDir, rel), function (err3, digest) {
          if (err3) return done(err3);
          done(null, { rel, expected: manifest.files[rel], actual: digest });
        });
      }, function (err4, checked) {
        if (err4) return callback(err4);
        const mismatches = checked
          .filter((c) => c.expected !== c.actual)
          .map((c) => c.rel);
        callback(null, {
          ok: mismatches.length === 0 && missing.length === 0,
          mismatches,
          missing,
          extra
        });
      });
    });
  });
};

function hashFile (absPath, callback) {
  const hash = crypto.createHash(ALGORITHM);
  const stream = fs.createReadStream(absPath);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', () => callback(null, hash.digest('hex')));
  stream.on('error', callback);
}

function walk (rootDir, callback) {
  const results = [];
  fs.readdir(rootDir, { withFileTypes: true }, function (err, entries) {
    if (err) return callback(err);
    async.eachSeries(entries, function (entry, done) {
      const absPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, function (err2, sub) {
          if (err2) return done(err2);
          results.push.apply(results, sub);
          done();
        });
      } else if (entry.isFile()) {
        results.push(absPath);
        done();
      } else {
        done(); // ignore symlinks, sockets, etc.
      }
    }, function (err3) {
      if (err3) return callback(err3);
      callback(null, results);
    });
  });
}

exports.MANIFEST_FILENAME = MANIFEST_FILENAME;
exports.ALGORITHM = ALGORITHM;
