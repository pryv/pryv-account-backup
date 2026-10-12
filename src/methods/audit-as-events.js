/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
const pager = require('./events-pager');

// Both audit-store top-level streams.
const STREAMS_PARAM = encodeURIComponent(JSON.stringify([
  ':_audit:accesses',
  ':_audit:actions'
]));

/**
 * Audit log fetch via the standard events API.
 *
 * Audit is registered as a regular @pryv/datastore mounted at the `:_audit:`
 * store prefix on every Pryv core: the streams `:_audit:accesses` (children:
 * `:_audit:accesses:access-<accessId>`) and `:_audit:actions` (children:
 * `:_audit:actions:action-<actionId>`) expose every audit-log event through
 * the same `events.get` interface that serves the rest of the user's data.
 * Crucially, `events.get` accepts `modifiedSince`, so the audit log can be
 * fetched incrementally — something the dedicated `audit.getLogs` endpoint
 * does not support.
 *
 * v0.4.0+ fetched the audit log via `audit/logs?fromTime=…&toTime=…` as a
 * single full-range round-trip. v0.6.0 routes audit through `events.get` so
 * the same incremental model that serves regular events also serves audit,
 * and the library has one event fetcher rather than two.
 *
 * Output: `audit_logs.json` on an initial run (filename unchanged from v0.5.0
 * for any consumer that keys on it); an incremental run writes its delta to
 * `audit_logs-incremental-<RUN-TS>.json` so the earlier file is kept. Content
 * shape is `{ events: [...], meta: {...} }`; the audit events appear under
 * their `:_audit:*` stream-ids.
 *
 * Audit events are read in explicit pages (see `events-pager`): a request with
 * no time range and no `limit` gets the server's default cap of 20 rows. Audit
 * events have no duration (`endTime` = `time`), so no running-events walk.
 * Deletions are not requested: the server only reports deletions of the
 * user's own events, which the events backup already carries.
 *
 * @param {object} connection { endpoint, token }
 * @param {object} writer StorageWriter
 * @param {object} options
 *        options.includeTrashed {boolean}   appends `&state=all`
 *        options.modifiedSince  {number}    UTC seconds; when present, fetch
 *                                           only audit events with
 *                                           `modified > T` (incremental run)
 *        options.runStartedAt   {number}    incremental output filename stamp
 *                                           (defaults to current epoch)
 *        options.pageSize       {number}    page size (default events-pager
 *                                           PAGE_SIZE)
 * @param {function} callback (err)
 * @param {function} [log] (msg)
 */
exports.download = function download (connection, writer, options, callback, log) {
  if (!log) log = console.log;
  if (writer == null || typeof writer.openWriteStream !== 'function') {
    throw new Error('audit-as-events.download requires a StorageWriter');
  }
  options = options || {};
  pager.toCallback(downloadAudit(connection, writer, options, log), callback);
};

async function downloadAudit (connection, writer, options, log) {
  const incremental = options.modifiedSince != null;
  const query = 'streams=' + STREAMS_PARAM +
    (incremental ? '&modifiedSince=' + options.modifiedSince : '') +
    (options.includeTrashed ? '&state=all' : '');
  const filename = incremental
    ? 'audit_logs-incremental-' + (options.runStartedAt || Math.floor(Date.now() / 1000)) + '.json'
    : 'audit_logs.json';
  const got = await pager.collectEvents(connection, query, { pageSize: options.pageSize });
  log('Audit log: ' + got.events.length + ' event(s) to ' + filename);
  const doc = { events: got.events };
  if (got.meta) doc.meta = got.meta;
  await pager.writeJSON(writer, filename, doc);
}

exports.STREAMS_PARAM = STREAMS_PARAM;
