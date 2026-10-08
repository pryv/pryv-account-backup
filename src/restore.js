/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
const fs = require('fs');
const path = require('path');
const RestoreReport = require('./restore-report');
const { errorOf } = RestoreReport;

// Stream ids starting with ':' belong to namespaces the server manages itself
// (account fields, audit, emails, shared secrets, ...). None of them can be
// replayed through `streams.create` / `events.create`; account fields are
// restored by their own step below. Ids starting with '.' are the legacy
// (v1) system streams.
const SERVER_MANAGED_PREFIX = ':';
const LEGACY_SYSTEM_PREFIX = '.';
// Account fields declared by the platform operator (`custom.systemStreams`).
const CUSTOMER_ACCOUNT_PREFIX = ':system:';
// The primary email is coordinated by `account.update` only.
const PRIMARY_EMAIL_STREAM_ID = ':system:email';
// Server-side ceiling on addresses per `emails.add` operation.
const MAX_EMAILS_PER_CALL = 20;

function isRestorableStreamId (streamId) {
  return !streamId.startsWith(LEGACY_SYSTEM_PREFIX) && !streamId.startsWith(SERVER_MANAGED_PREFIX);
}

/**
 * Return event-data files in a backup directory, sorted. Includes the legacy
 * single-file `events.json` (older backups) and any chunked
 * `events-YYYY-MM.json` (0.5.0+).
 */
function listEventFiles (sourcePath) {
  const files = [];
  const legacy = path.join(sourcePath, 'events.json');
  if (fs.existsSync(legacy)) files.push(legacy);
  if (fs.existsSync(sourcePath)) {
    const chunks = fs.readdirSync(sourcePath)
      .filter((n) => n.startsWith('events-') && n.endsWith('.json'))
      .sort();
    for (const name of chunks) files.push(path.join(sourcePath, name));
  }
  return files;
}

/**
 * Read every event of the backup. 0.5.0+ writes one `events-YYYY-MM.json` per
 * chunk; older backups have a single `events.json`. Read whichever exists (or
 * both, sorted) and concatenate the `events` arrays.
 */
function readEvents (sourcePath) {
  const eventFiles = listEventFiles(sourcePath);
  if (eventFiles.length === 0) {
    throw new Error('No events.json or events-YYYY-MM.json found in ' + sourcePath);
  }
  const allEvents = [];
  for (const file of eventFiles) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(parsed.events)) {
      for (const e of parsed.events) allEvents.push(e);
    }
  }
  const events = latestEventVersions(allEvents);
  console.log('Read ' + allEvents.length + ' event entr(ies) from ' + eventFiles.length + ' file(s), ' +
    events.length + ' event(s) to restore.');
  return events;
}

/**
 * An incremental backup writes `events-incremental-<time>.json` with every
 * event changed since the previous run, so one event can appear in several
 * files, and a deletion appears as `{ id, deleted }`. Keep only the latest
 * version of each event (by `deleted` or `modified`), in first-seen order, and
 * drop deleted ones; otherwise the oldest copy is created and the newer one
 * refused as a duplicate.
 */
function latestEventVersions (entries) {
  const latest = new Map();
  const stamp = (e) => e.deleted || e.modified || 0;
  for (const e of entries) {
    if (!e || !e.id) continue;
    const previous = latest.get(e.id);
    if (!previous || stamp(e) >= stamp(previous)) latest.set(e.id, e);
  }
  return [...latest.values()].filter((e) => !e.deleted);
}

async function restoreStreams (connection, sourcePath, report) {
  const ressourceFile = path.join(sourcePath, 'streams.json');
  const content = JSON.parse(fs.readFileSync(ressourceFile, 'utf-8'));
  const streams = [];

  function parseTree (streamList) {
    streamList.forEach((s) => {
      ['modified', 'modifiedBy', 'created', 'createdBy'].forEach((key) => { delete s[key]; });
      if (isRestorableStreamId(s.id)) {
        const childs = s.children;
        delete s.children;
        streams.push(s);
        if (childs) parseTree(childs);
      } else if (s.id.startsWith(SERVER_MANAGED_PREFIX)) {
        // Children of a server-managed stream are server-managed too.
        report.recordSkip('streams', s.id, 'server-managed stream (not replayed)');
      }
    });
  }
  parseTree(content.streams);
  await uploadInBatch(connection, streams, 'streams', report);
}

/**
 * Restore account fields through the methods meant for them, never by
 * replaying their events:
 * - language and primary email from `account.json`, via `account.update`;
 * - additional addresses, only when asked to, as pending (`emails.add` sends
 *   them a verification mail);
 * - operator-declared custom fields, via `events.update` on the field's
 *   existing event on the target (the documented way to edit them).
 * Verification state is never restored: the target decides it.
 */
async function restoreAccount (connection, sourcePath, allEvents, options, report) {
  const got = await connection.api([{ method: 'account.get', params: {} }]);
  const getError = errorOf(got && got[0]);
  if (getError) {
    report.recordCall('account', 'account.get', got && got[0]);
    return;
  }
  const target = got[0].account || {};

  const exported = readAccountFile(sourcePath);
  if (exported) {
    await restoreLanguage(connection, exported, target, report);
    await restoreEmails(connection, exported, target, options, report);
  } else {
    report.note('no account.json in the backup: language and email were not restored');
  }
  await restoreCustomAccountFields(connection, allEvents, report);
}

function readAccountFile (sourcePath) {
  const file = path.join(sourcePath, 'account.json');
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return parsed.account || null;
}

async function restoreLanguage (connection, exported, target, report) {
  if (!exported.language || exported.language === target.language) return;
  const res = await connection.api([{ method: 'account.update', params: { update: { language: exported.language } } }]);
  report.recordCall('account', 'language', res && res[0]);
}

async function restoreEmails (connection, exported, target, options, report) {
  const exportedEmails = Array.isArray(exported.emails) && exported.emails.length > 0
    ? exported.emails
    : (exported.email ? [{ value: exported.email, primary: true }] : []);
  const primaryEntry = exportedEmails.find((e) => e.primary);
  const primary = (primaryEntry && primaryEntry.value) || exported.email || null;

  // For the record: what the source said about each address. The target
  // decides verification on its own; it is never copied.
  for (const e of exportedEmails) {
    report.note('email ' + e.value + (e.primary ? ' (primary)' : '') +
      ': status in the backup "' + (e.status || 'unknown') + '"' +
      (e.verifiedAt ? ', verified at ' + new Date(e.verifiedAt * 1000).toISOString() : '') +
      '; verification state is not restored');
  }

  const onTarget = new Set();
  if (target.email) onTarget.add(target.email.toLowerCase());
  for (const e of (target.emails || [])) if (e && e.value) onTarget.add(e.value.toLowerCase());

  if (primary && primary.toLowerCase() !== (target.email || '').toLowerCase()) {
    const res = await connection.api([{ method: 'account.update', params: { update: { email: primary } } }]);
    const error = errorOf(res && res[0]);
    if (error && error.id === 'item-already-exists') {
      report.recordSkip('account', 'email ' + primary, 'already used by another account on the target platform');
    } else {
      report.recordCall('account', 'email ' + primary, res && res[0]);
      if (!error) onTarget.add(primary.toLowerCase());
    }
  }

  const secondaries = exportedEmails
    .filter((e) => !e.primary && e.value && !onTarget.has(e.value.toLowerCase()))
    .map((e) => e.value)
    .slice(0, MAX_EMAILS_PER_CALL);
  if (secondaries.length === 0) return;
  if (!options.restoreSecondaryEmails) {
    for (const value of secondaries) {
      report.recordSkip('account', 'email ' + value,
        'additional address not re-added (use --restore-secondary-emails to add it as pending; it sends a verification mail)');
    }
    return;
  }
  // One call per address, so one refused address does not block the others.
  const calls = secondaries.map((value) => ({ method: 'account.update', params: { update: { emails: { add: [value] } } } }));
  const res = await connection.api(calls);
  secondaries.forEach((value, i) => {
    const error = errorOf(res && res[i]);
    if (error && error.id === 'item-already-exists') {
      report.recordSkip('account', 'email ' + value, 'already used by another account on the target platform');
    } else {
      report.recordCall('account', 'email ' + value + ' (pending)', res && res[i]);
    }
  });
}

/**
 * Latest exported event per operator-declared account field, the primary
 * email excepted. Deleted and trashed entries are ignored.
 */
function customAccountFieldEvents (allEvents) {
  const byStream = new Map();
  for (const e of allEvents) {
    if (e.deleted || e.trashed) continue;
    for (const streamId of (e.streamIds || [])) {
      if (!streamId.startsWith(CUSTOMER_ACCOUNT_PREFIX) || streamId === PRIMARY_EMAIL_STREAM_ID) continue;
      const previous = byStream.get(streamId);
      if (!previous || (e.modified || 0) >= (previous.modified || 0)) byStream.set(streamId, e);
    }
  }
  return byStream;
}

async function restoreCustomAccountFields (connection, allEvents, report) {
  const byStream = customAccountFieldEvents(allEvents);
  const streamIds = [...byStream.keys()];
  if (streamIds.length === 0) return;

  const lookups = streamIds.map((streamId) => ({ method: 'events.get', params: { streams: [streamId], limit: 1 } }));
  const found = await connection.api(lookups);

  const updates = [];
  const updatedStreamIds = [];
  streamIds.forEach((streamId, i) => {
    const error = errorOf(found && found[i]);
    if (error) {
      report.recordSkip('account', streamId, 'field not readable on the target (' + (error.id || 'error') + ')');
      return;
    }
    const current = (found[i].events || [])[0];
    if (!current) {
      report.recordSkip('account', streamId, 'the target has no value for this field to update');
      return;
    }
    const wanted = byStream.get(streamId).content;
    if (JSON.stringify(current.content) === JSON.stringify(wanted)) return;
    updates.push({ method: 'events.update', params: { id: current.id, update: { content: wanted } } });
    updatedStreamIds.push(streamId);
  });
  if (updates.length === 0) return;

  const res = await connection.api(updates);
  updatedStreamIds.forEach((streamId, i) => {
    const error = errorOf(res && res[i]);
    if (error && error.id === 'invalid-operation' && error.data && error.data.streamId === streamId) {
      report.recordSkip('account', streamId, 'field is not editable on the target');
    } else {
      report.recordCall('account', streamId, res && res[i]);
    }
  });
}

async function restoreEvents (connection, allEvents, sourcePath, report) {
  console.log('Restoring ' + allEvents.length + ' event(s).');
  const standardEvents = [];
  const eventsWithAttachments = [];
  const eventsSeries = [];
  let notReplayed = 0;
  allEvents.forEach((e) => {
    ['modified', 'modifiedBy', 'streamId', 'created', 'createdBy'].forEach((key) => { delete e[key]; });
    // Drop system and server-managed streams; account fields were handled by
    // restoreAccount().
    e.streamIds = (e.streamIds || []).filter(isRestorableStreamId);

    // uncomment the following line to change event Ids, usefull when loading on the same system
    // e.oldId = e.id; e.id = cuid();

    // uncomment the following line to add a delay
    // e.time = e.time + (365 * 24 * 60 * 60 * 2);

    console.log('+', e.time, new Date(e.time * 1000));
    if (e.streamIds.length > 0) {
      if (e.attachments && e.attachments.length > 0) {
        eventsWithAttachments.push(e);
      } else if (e.type.startsWith('series:')) {
        // Keep oldId so we can map it to the new event id after events.create
        // and locate the matching hf-data/<oldId>.json file.
        e.oldId = e.id;
        delete e.id;
        delete e.attachments;
        eventsSeries.push(e);
      } else {
        delete e.oldId;
        delete e.attachments;
        standardEvents.push(e);
      }
    } else {
      notReplayed++;
    }
  });
  if (notReplayed > 0) {
    report.note(notReplayed + ' event(s) only in system or server-managed streams were not replayed' +
      ' (account fields are restored by the account step)');
  }

  await uploadInBatch(connection, standardEvents, 'events', report);
  await uploadEventsWithAttachments(connection, eventsWithAttachments, sourcePath, report);
  // Series events used to be filtered but never restored (eventsSeries was
  // a dead bucket since at least v0.2.x). Now we create the container event
  // AND, if the backup carries the matching hf-data/<oldId>.json, re-upload
  // the data points via the lib's addPointsToHFEvent helper.
  await restoreSeriesEvents(connection, eventsSeries, sourcePath, report);
}

async function restoreSeriesEvents (connection, seriesEvents, sourcePath, report) {
  if (seriesEvents.length === 0) {
    console.log('No series events to restore.');
    return;
  }
  console.log('Restoring ' + seriesEvents.length + ' series event(s).');
  const oldIds = seriesEvents.map(function (e) { return e.oldId; });
  const calls = seriesEvents.map(function (e) {
    const params = Object.assign({}, e);
    delete params.oldId;
    return { method: 'events.create', params };
  });
  const res = await connection.api(calls, function (progress) {
    console.log('Uploading series events ' + progress + '%');
  });
  fs.writeFileSync('res_series_events.log', JSON.stringify(res, null, 2));

  const hfDataDir = path.join(sourcePath, 'hf-data');
  for (let i = 0; i < res.length; i++) {
    const result = res[i] || {};
    const oldId = oldIds[i];
    report.recordCall('series events', oldId, res[i]);
    const newEvent = result.event || (result.body && result.body.event);
    if (!newEvent || !newEvent.id) {
      console.log('Skipping HFS data restore for ' + oldId + ' (events.create failed)');
      continue;
    }
    const newId = newEvent.id;
    const hfFile = path.join(hfDataDir, oldId + '.json');
    if (!fs.existsSync(hfFile)) {
      console.log('No hf-data file for ' + oldId + ' (skipping data points)');
      continue;
    }
    try {
      const hf = JSON.parse(fs.readFileSync(hfFile, 'utf-8'));
      // GET /events/<id>/series may answer top-level or wrapped in `data`.
      const payload = (hf && hf.data) ? hf.data : hf;
      const fields = payload.fields;
      const points = payload.points;
      if (!Array.isArray(fields) || !Array.isArray(points)) {
        console.log('Skipping HFS data restore for ' + oldId + ' (unexpected hf-data shape)');
        report.recordSkip('series data', oldId, 'unexpected hf-data shape');
        continue;
      }
      if (points.length === 0) {
        console.log('HFS data for ' + oldId + ' is empty (0 points)');
        continue;
      }
      await connection.addPointsToHFEvent(newId, fields, points);
      report.recordCall('series data', oldId, {});
      console.log('Restored HFS data for ' + oldId + ' → ' + newId + ' (' + points.length + ' points)');
    } catch (err) {
      report.recordFailure('series data', oldId, err);
      console.log('Failed HFS data restore for ' + oldId + ': ' + (err.message || err));
    }
  }
}

async function uploadEventsWithAttachments (connection, eventsWithAttachments, sourcePath, report) {
  const res = [];
  for (let i = 0; i < eventsWithAttachments.length; i++) {
    const e = eventsWithAttachments[i];
    const attachmentCount = e.attachments.length;
    console.log('Uploading event with ' + attachmentCount + ' attachment(s):', e.id);
    const fileId = e.oldId || e.id;
    const attachmentList = e.attachments;
    delete e.attachments;
    delete e.oldId;
    try {
      let result;
      if (attachmentCount === 1) {
        // Single-attachment path — keep using createEventWithFile for the
        // simplest case (no FormData ceremony required).
        const a = attachmentList[0];
        const filepath = path.join(sourcePath, 'attachments', fileId + '_' + a.fileName);
        result = await connection.createEventWithFile(e, filepath);
      } else {
        // Multi-attachment restore via pryv@3's createEventWithFormData.
        // Native Node 18+ FormData + fs.openAsBlob upload N file parts in a
        // single POST /events call.
        const formData = new FormData();
        for (const a of attachmentList) {
          const filepath = path.join(sourcePath, 'attachments', fileId + '_' + a.fileName);
          const mimeType = a.type || 'application/octet-stream';
          const fileBlob = await fs.promises.readFile(filepath)
            .then((buf) => new Blob([buf], { type: mimeType }));
          formData.append('file', fileBlob, a.fileName);
        }
        result = await connection.createEventWithFormData(e, formData);
      }
      res.push(result);
      report.recordCall('events with attachments', fileId, result);
    } catch (err) {
      if (err && err.response && err.response.body) {
        res.push(err.response.body);
      } else {
        res.push('' + err);
      }
      report.recordFailure('events with attachments', fileId, err);
    }
  }
  fs.writeFileSync('res_attachments.log', JSON.stringify(res, null, 2));
}

async function uploadInBatch (connection, data, ressource, report) {
  const calls = [];
  data.forEach((item) => {
    calls.push({ method: ressource + '.create', params: item });
  });
  const res = await connection.api(calls, (progress) => {
    console.log('Uploading ' + ressource + ' ' + progress + '%');
  });
  fs.writeFileSync('res_' + ressource + '.log', JSON.stringify(res, null, 2));
  report.recordBatch(ressource, calls, res);
}

/**
 * Restore a backup directory into the account of `connection`.
 * Resolves with a RestoreReport; it does not throw on refused calls, the
 * caller decides what a refusal means (the CLI exits non-zero).
 *
 * @param {Object} [options]
 * @param {boolean} [options.restoreSecondaryEmails=false] re-add non-primary
 *   addresses as pending (sends each a verification mail)
 */
async function restore (connection, source, options = {}) {
  const report = new RestoreReport();
  await restoreStreams(connection, source, report);
  const allEvents = readEvents(source);
  await restoreAccount(connection, source, allEvents, options, report);
  await restoreEvents(connection, allEvents, source, report);
  return report;
}

module.exports = restore;
module.exports.isRestorableStreamId = isRestorableStreamId;
module.exports.customAccountFieldEvents = customAccountFieldEvents;
module.exports.latestEventVersions = latestEventVersions;
