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

const SYNC_STATE_FILE = 'sync-state.json';

/**
 * Backup — the orchestrator that runs a full account dump.
 *
 * Drives two pluggable adapters: `StorageWriter` (bytes out) +
 * `StateStore` (kv state + per-category work refs). The same orchestration
 * runs in both Node and the browser sample webapp.
 *
 * Per-resource refs (attachments, series-event, webhook) are PUSHED into the
 * StateStore during metadata + events fetches via the `onParsed` hook in
 * `api-resources` (and the `onEvents` lift in `events-chunked`), then DRAINED
 * by the per-method modules (`attachments.download`, `hf-data.download`,
 * `webhooks-export.download`). Each successful per-ref download is marked
 * done in the store so an interrupted run resumes on still-pending refs
 * rather than re-downloading completed work.
 *
 * At run-end the orchestrator writes a portable `sync-state.json` via the
 * writer — kv state only, no refs. CLI subjects find it in the backup
 * directory; webapp subjects find it inside the final ZIP. They keep it
 * alongside their backup; on the next run they re-upload it (webapp) or
 * the CLI auto-reads it from disk, and incremental thresholds carry over.
 *
 * Typical CLI usage:
 *
 *   const connection = await Service.login(...);
 *   const writer = new NodeFsStorageWriter(backupDirectory);
 *   const state = new FolderStateStore(backupDirectory.baseDir);
 *   const backup = new Backup({ connection, writer, state, options });
 *   backup.run((err) => { ... });
 */
class Backup {
  /**
   * @param {object} cfg
   * @param {object} cfg.connection         pryv.Connection (logged-in)
   * @param {StorageWriter} cfg.writer      destination adapter
   * @param {StateStore} [cfg.state]        kv state + work-ref tracker
   * @param {object} [cfg.options]          per-run options
   * @param {boolean} [cfg.options.includeTrashed]
   * @param {boolean} [cfg.options.includeAttachments]
   * @param {boolean} [cfg.options.includeHfData]
   * @param {boolean} [cfg.options.includeWebhooks]
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
   * Run the backup. Flow:
   *   1. metadata resources (account, streams, accesses + accesses-all,
   *      profile/private, profile/public) — accesses fetch tees webhook refs
   *      into the store
   *   2. audit-as-events
   *   3. events chunked by month (or incremental) — tees attachment +
   *      series-event refs into the store
   *   4. per-app profile fetches
   *   5. per-access version history (opt-in)
   *   6. attachments drain (opt-in)
   *   7. HFS series data points drain (opt-in)
   *   8. webhooks drain (opt-in)
   *   9. persist sync-state kv + write portable `sync-state.json` via writer
   *  10. integrity manifest
   *
   * @param {function(Error?)} callback
   */
  run (callback) {
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
    if (state == null) {
      return callback(new Error('Backup requires a StateStore (since v0.7.0). ' +
        'Pass `new FolderStateStore(backupDirectory.baseDir)`.'));
    }

    const runStartedAt = Math.floor(Date.now() / 1000);

    let eventsModifiedSince = null;
    let auditModifiedSince = null;
    (async function loadIncrementalState () {
      const prior = await state.get(STATE_KEYS.lastRunAt);
      if (prior == null) return;
      eventsModifiedSince = await state.get(STATE_KEYS.eventsLastModifiedSince);
      auditModifiedSince = await state.get(STATE_KEYS.auditLastModifiedSince);
      if (eventsModifiedSince == null) eventsModifiedSince = prior;
      if (auditModifiedSince == null) auditModifiedSince = prior;
    })().then(runOrchestration, callback);

    function pushAttachmentRefs (events) {
      return Promise.all(events.map(async function (e) {
        if (!e || !Array.isArray(e.attachments)) return;
        for (const att of e.attachments) {
          if (!att || !att.id) continue;
          await state.pushRef('attachment', {
            key: e.id + ':' + att.id,
            eventId: e.id,
            attId: att.id,
            fileName: att.fileName || att.id,
            readToken: att.readToken
          });
        }
      })).then(function () {});
    }

    function pushSeriesEventRefs (events) {
      return Promise.all(events.map(async function (e) {
        if (!e || typeof e.type !== 'string' || e.type.indexOf('series:') !== 0) return;
        await state.pushRef('series-event', {
          key: e.id,
          eventId: e.id,
          type: e.type
        });
      })).then(function () {});
    }

    function onEventsParsed (events) {
      return Promise.all([
        pushAttachmentRefs(events),
        pushSeriesEventRefs(events)
      ]).then(function () {});
    }

    function onAccessesParsed (doc) {
      const accesses = Array.isArray(doc.accesses) ? doc.accesses : [];
      return Promise.all(accesses.map(async function (a) {
        if (!a || typeof a.token !== 'string' || a.token.length === 0) return;
        await state.pushRef('webhook', {
          key: a.id,
          accessId: a.id,
          token: a.token,
          type: a.type
        });
      })).then(function () {});
    }

    function runOrchestration () {
      async.series([
        function createDirectoryTree (done) {
          backupDirectory.createDirs(done, log);
        },
        function clearStaleRefs (done) {
          // Carry-over refs from a prior interrupted run get re-discovered
          // via the events / accesses streams below; clearing the store
          // sidesteps "phantom pending" refs whose threshold has since moved.
          Promise.all([
            state.clearCategory('attachment'),
            state.clearCategory('series-event'),
            state.clearCategory('webhook')
          ]).then(function () { done(); }, done);
        },
        function fetchData (done) {
          log('Starting Backup' + (eventsModifiedSince != null ? ' (incremental)' : ' (initial)'));

          if (eventsModifiedSince == null && backupDirectory.hasEventsData()) {
            // Operator interrupted an earlier run; events on disk are
            // preserved. Re-derive accesses-keyed webhook refs from disk so
            // the drain step still has work to do.
            return reloadAccessesFromDisk(backupDirectory, onAccessesParsed, log, done);
          }

          let streamsRequest = 'streams';
          if (params.includeTrashed) {
            streamsRequest += '?state=all';
          }

          const accessesAllRequest = 'accesses?includeDeletions=true&includeExpired=true';
          const resources = [
            { res: 'account' },
            { res: streamsRequest },
            { res: 'accesses', onParsed: onAccessesParsed },
            { res: accessesAllRequest, extra: '-all' },
            { res: 'profile/private' },
            { res: 'profile/public' }
          ];
          async.mapSeries(resources, function (item, cb) {
            apiResources.toJSONFile({
              writer: writer,
              resource: item.res,
              extraFileName: item.extra || '',
              connection: connection,
              onParsed: item.onParsed
            }, cb, log);
          }, done);
        },
        function fetchAuditAsEvents (stepDone) {
          auditAsEvents.download(connection, writer, {
            includeTrashed: params.includeTrashed,
            modifiedSince: auditModifiedSince
          }, stepDone, log);
        },
        function fetchEventsChunked (stepDone) {
          eventsChunked.download(connection, writer, {
            includeTrashed: params.includeTrashed,
            modifiedSince: eventsModifiedSince,
            runStartedAt: runStartedAt,
            fromTime: params.fromTime,
            toTime: params.toTime,
            chunkMonths: params.eventsChunkMonths,
            onEvents: onEventsParsed
          }, stepDone, log);
        },
        function fetchAppProfiles (stepDone) {
          const accessesData = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
          async.mapSeries(accessesData.accesses, function (access, cb) {
            if (access.type !== 'app') return cb();
            apiResources.toJSONFile({
              writer: writer,
              resource: 'profile/app',
              extraFileName: '_' + access.id,
              filename: 'app_profiles/profile_app_' + access.id + '.json',
              connection: { endpoint: connection.endpoint, token: access.token }
            }, cb, log);
          }, stepDone);
        },
        function fetchAccessHistory (stepDone) {
          if (!params.includeAccessHistory) {
            log('Skipping per-access version history (opt-in)');
            return stepDone();
          }
          const accessesData = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
          accessesHistory.download(connection, writer, accessesData.accesses || [], stepDone, log);
        },
        function drainAttachments (stepDone) {
          if (!params.includeAttachments) {
            log('Skipping attachments');
            return stepDone();
          }
          attachments.download(connection, writer, state, {}, stepDone, log);
        },
        function drainHfData (stepDone) {
          if (params.includeHfData === false) {
            log('Skipping HFS series data (opt-out)');
            return stepDone();
          }
          hfData.download(connection, writer, state, {}, stepDone, log);
        },
        function drainWebhooks (stepDone) {
          if (params.includeWebhooks === false) {
            log('Skipping webhooks (opt-out)');
            return stepDone();
          }
          webhooksExport.download(connection, writer, state, {}, stepDone, log);
        },
        function persistRunState (stepDone) {
          (async function () {
            await state.set(STATE_KEYS.formatVersion, STATE_FORMAT_VERSION);
            await state.set(STATE_KEYS.toolVersion, pkg.version);
            await state.set(STATE_KEYS.lastRunAt, runStartedAt);
            await state.set(STATE_KEYS.eventsLastModifiedSince, runStartedAt);
            await state.set(STATE_KEYS.auditLastModifiedSince, runStartedAt);
            await state.flush();
          })().then(function () { stepDone(); }, stepDone);
        },
        function writeSyncStateFile (stepDone) {
          (async function () {
            const snapshot = await state.export();
            const body = JSON.stringify(snapshot, null, 2);
            const ws = writer.openWriteStream(SYNC_STATE_FILE);
            ws.write(body);
            await new Promise(function (resolve, reject) {
              if (typeof ws.end !== 'function') return resolve();
              ws.end(function (err) { err ? reject(err) : resolve(); });
            });
          })().then(function () { stepDone(); }, stepDone);
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
Backup.SYNC_STATE_FILE = SYNC_STATE_FILE;

module.exports = Backup;

function reloadAccessesFromDisk (backupDirectory, onParsed, log, callback) {
  if (!fs.existsSync(backupDirectory.accessesFile)) {
    log('No accesses.json on disk — skipping webhook-ref reload.');
    return callback();
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(backupDirectory.accessesFile, 'utf8'));
  } catch (err) {
    return callback(err);
  }
  Promise.resolve(onParsed(parsed)).then(function () { callback(); }, callback);
}
