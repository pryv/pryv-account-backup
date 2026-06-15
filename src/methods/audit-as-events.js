const apiResources = require('./api-resources');

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
 * Output: `audit_logs.json` (filename unchanged from v0.5.0 for any consumer
 * that keys on it). Content shape is `{ events: [...], meta: {...} }` — the
 * standard events.get response shape; the audit events appear under their
 * `:_audit:*` stream-ids the same way they would if queried via the dedicated
 * endpoint.
 *
 * @param {object} connection { endpoint, token }
 * @param {object} backupDirectory BackupDirectory instance
 * @param {object} options
 *        options.includeTrashed {boolean}   appends `&state=all`
 *        options.modifiedSince  {number}    UTC seconds; when present, fetch
 *                                           only audit events with
 *                                           `modified > T` (incremental run)
 * @param {function} callback (err)
 * @param {function} [log] (msg)
 */
exports.download = function download (connection, backupDirectory, options, callback, log) {
  if (!log) log = console.log;
  options = options || {};
  const stateAll = options.includeTrashed ? '&state=all' : '';
  const modifiedClause = (options.modifiedSince != null)
    ? '&modifiedSince=' + options.modifiedSince
    : '';

  // Both audit-store top-level streams.
  const streamsParam = encodeURIComponent(JSON.stringify([
    ':_audit:accesses',
    ':_audit:actions'
  ]));

  // includeDeletions=true so audit-row deletions (rare — audit is generally
  // append-only — but possible under operator retention policy) show up in
  // the incremental delta.
  const resource = 'events?streams=' + streamsParam +
    '&includeDeletions=true' +
    modifiedClause +
    stateAll;

  apiResources.toJSONFile({
    folder: backupDirectory.baseDir,
    resource: resource,
    connection: connection,
    // Use the canonical `audit_logs.json` filename regardless of which
    // endpoint produced it; consumers keying on the path keep working.
    filename: 'audit_logs.json'
  }, callback, log);
};
