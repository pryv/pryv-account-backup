const fs = require('fs');
const async = require('async');
const apiResources = require('../methods/api-resources');
const attachments = require('../methods/attachments');
const hfData = require('../methods/hf-data');
const webhooksExport = require('../methods/webhooks-export');
const eventsChunked = require('../methods/events-chunked');
const accessesHistory = require('../methods/accesses-history');
const auditAsEvents = require('../methods/audit-as-events');
const manifest = require('../methods/manifest');
const pkg = require('../../package.json');

const STATE_FORMAT_VERSION = 1;
const STATE_KEYS = {
  formatVersion: 'formatVersion',
  toolVersion: 'toolVersion',
  lastRunAt: 'lastRunAt',
  eventsLastModifiedSince: 'events.lastModifiedSince',
  auditLastModifiedSince: 'audit.lastModifiedSince'
};

/**
 * Backup — the orchestrator that runs a full account dump.
 *
 * Phase A: this class wraps the v0.5.0 `startOnConnection` orchestration so
 * the library has a class entrypoint that consumes pluggable adapters
 * (`StorageWriter` + `StateStore`). Behavior is identical to v0.5.0 — the
 * per-method modules still consume the legacy `BackupDirectory` exposed via
 * the writer's `legacyDirectory()` shim. Phase B will migrate the per-method
 * modules to consume the writer + state directly.
 *
 * Typical CLI usage:
 *
 *   const connection = await Service.login(...);
 *   const writer = new NodeFsStorageWriter(backupDirectory);
 *   const state = new FolderStateStore(backupDirectory.baseDir);
 *   const backup = new Backup({ connection, writer, state, options });
 *   backup.run((err) => { ... });
 *
 * The CLI's `scripts/start-backup.js` continues to call the legacy
 * `exports.start(params, callback)` API in `src/main.js`, which constructs a
 * `Backup` internally; existing CLI users see no behavior change.
 */
class Backup {
  /**
   * @param {object} cfg
   * @param {object} cfg.connection         pryv.Connection (logged-in)
   * @param {StorageWriter} cfg.writer      destination adapter
   * @param {StateStore} [cfg.state]        incremental state (Phase B uses this)
   * @param {object} [cfg.options]          per-run options
   * @param {boolean} [cfg.options.includeTrashed]
   * @param {boolean} [cfg.options.includeAttachments]
   * @param {boolean} [cfg.options.includeAccessHistory]
   * @param {number}  [cfg.options.eventsChunkMonths]
   * @param {number}  [cfg.options.fromTime]
   * @param {number}  [cfg.options.toTime]
   * @param {function} [cfg.log]            (msg) => void; defaults to console.log
   */
  constructor (cfg) {
    if (cfg == null) throw new Error('Backup requires a config object');
    if (cfg.connection == null) throw new Error('Backup requires a connection');
    if (cfg.writer == null) throw new Error('Backup requires a writer');
    this.connection = cfg.connection;
    this.writer = cfg.writer;
    this.state = cfg.state || null;
    this.options = cfg.options || {};
    this.log = cfg.log || console.log;
  }

  /**
   * Run the backup. Mirrors the v0.5.0 `startOnConnection` flow:
   *   1. metadata resources (account, streams, accesses + accesses-all,
   *      profile/private, profile/public, audit/logs)
   *   2. per-app profile fetches (`/profile/app` per `app`-type access)
   *   3. events chunked by month (`events-YYYY-MM.json`)
   *   4. per-access version history (`accesses-history/<id>.json`, opt-in)
   *   5. attachments (opt-in)
   *   6. HFS series data points (per `series:*` event)
   *   7. webhooks per access
   *   8. integrity manifest
   *
   * @param {function(Error?)} callback
   */
  run (callback) {
    const self = this;
    const connection = this.connection;
    const writer = this.writer;
    const state = this.state;
    const params = this.options;
    const log = this.log;
    const backupDirectory = writer.legacyDirectory();
    if (backupDirectory == null) {
      return callback(new Error(
        'Backup requires a writer constructed from a BackupDirectory in this release. ' +
        'Pass `new NodeFsStorageWriter(backupDirectory)` rather than a bare path.'
      ));
    }

    const runStartedAt = Math.floor(Date.now() / 1000);

    // Resolve incremental thresholds from prior state. When the state store
    // is absent OR carries no prior `lastRunAt`, this is the first run on
    // this backup directory — fall back to the chunked initial-fetch path.
    let eventsModifiedSince = null;
    let auditModifiedSince = null;
    (async function loadIncrementalState () {
      if (state == null) return;
      const prior = await state.get(STATE_KEYS.lastRunAt);
      if (prior == null) return;
      eventsModifiedSince = await state.get(STATE_KEYS.eventsLastModifiedSince);
      auditModifiedSince = await state.get(STATE_KEYS.auditLastModifiedSince);
      // Fall back to lastRunAt if a resource-level threshold is missing.
      if (eventsModifiedSince == null) eventsModifiedSince = prior;
      if (auditModifiedSince == null) auditModifiedSince = prior;
    })().then(runOrchestration, callback);

    function runOrchestration () {
      async.series([
        function createDirectoryTree (done) {
          backupDirectory.createDirs(done, log);
        },
        function fetchData (done) {
          log('Starting Backup' + (eventsModifiedSince != null ? ' (incremental)' : ' (initial)'));

          // Skip metadata fetch on incremental re-runs — the small resources
          // get full-refetched below. The skip-on-events-present check is
          // preserved for backwards compatibility with v0.5.0 partial-rerun
          // behavior (operator interrupted the first run, restarts with
          // events already on disk).
          if (eventsModifiedSince == null && backupDirectory.hasEventsData()) {
            return done();
          }

          let streamsRequest = 'streams';
          if (params.includeTrashed) {
            streamsRequest += '?state=all';
          }

          // Audit no longer rides this list — it's fetched via
          // events.get on :_audit:* streams in a dedicated step below so
          // modifiedSince applies (the dedicated /audit/logs endpoint does
          // not support modifiedSince).
          const accessesAllRequest = 'accesses?includeDeletions=true&includeExpired=true';
          async.mapSeries([
            'account', streamsRequest, 'accesses', accessesAllRequest,
            'profile/private', 'profile/public'
          ], function (resource, cb) {
            const extra = resource === accessesAllRequest ? '-all' : '';
            apiResources.toJSONFile({
              folder: backupDirectory.baseDir,
              resource: resource,
              extraFileName: extra,
              connection: connection
            }, cb, log);
          }, done);
        },
        function fetchAuditAsEvents (stepDone) {
          auditAsEvents.download(connection, backupDirectory, {
            includeTrashed: params.includeTrashed,
            modifiedSince: auditModifiedSince
          }, stepDone, log);
        },
        function fetchEventsChunked (stepDone) {
          eventsChunked.download(connection, backupDirectory, {
            includeTrashed: params.includeTrashed,
            modifiedSince: eventsModifiedSince,
            runStartedAt: runStartedAt,
            fromTime: params.fromTime,
            toTime: params.toTime,
            chunkMonths: params.eventsChunkMonths
          }, stepDone, log);
        },
        function fetchAppProfiles (stepDone) {
          const accessesData = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
          async.mapSeries(accessesData.accesses, function (access, cb) {
            if (access.type !== 'app') return cb();
            apiResources.toJSONFile({
              folder: backupDirectory.appProfilesDir,
              resource: 'profile/app',
              extraFileName: '_' + access.id,
              connection: { endpoint: connection.endpoint, token: access.token }
            }, cb, log);
          }, stepDone);
        },
        function fetchAccessHistory (stepDone) {
          if (!params.includeAccessHistory) {
            log('Skipping per-access version history (opt-in)');
            return stepDone();
          }
          accessesHistory.download(connection, backupDirectory, stepDone, log);
        },
        function fetchAttachments (stepDone) {
          if (params.includeAttachments) {
            attachments.download(connection, backupDirectory, stepDone, log);
          } else {
            log('Skipping attachments');
            stepDone();
          }
        },
        function fetchHFData (stepDone) {
          hfData.download(connection, backupDirectory, stepDone, log);
        },
        function fetchWebhooks (stepDone) {
          webhooksExport.download(connection, backupDirectory, stepDone, log);
        },
        function persistRunState (stepDone) {
          if (state == null) return stepDone();
          // Persist incremental thresholds for the next run. Use the
          // run-start timestamp as the threshold — events / audit modified
          // strictly after `runStartedAt` will be picked up next time.
          // Conservative: re-fetch any event modified DURING the run (a small
          // overlap is harmless; missing one is not).
          (async () => {
            await state.set(STATE_KEYS.formatVersion, STATE_FORMAT_VERSION);
            await state.set(STATE_KEYS.toolVersion, pkg.version);
            await state.set(STATE_KEYS.lastRunAt, runStartedAt);
            await state.set(STATE_KEYS.eventsLastModifiedSince, runStartedAt);
            await state.set(STATE_KEYS.auditLastModifiedSince, runStartedAt);
            await state.flush();
          })().then(() => stepDone(), stepDone);
        },
        function writeManifest (stepDone) {
          manifest.generate(backupDirectory.baseDir, { version: pkg.version, log }, stepDone);
        }
      ], function (err) {
        if (err) {
          log('Failed in process with error' + err);
          return callback(err);
        }
        callback();
      });
    }
  }
}

Backup.STATE_FORMAT_VERSION = STATE_FORMAT_VERSION;
Backup.STATE_KEYS = STATE_KEYS;

module.exports = Backup;
