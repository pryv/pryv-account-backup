const fs = require('fs');
const path = require('path');
const cuid = require('cuid');

async function restoreStreams (connection, sourcePath) {
  const ressourceFile = path.join(sourcePath, 'streams.json');
  const content = JSON.parse(fs.readFileSync(ressourceFile, 'utf-8'));
  const streams = [];

  function parseTree (streamList) {
    streamList.forEach((s) => {
      ['modified', 'modifiedBy', 'created', 'createdBy'].forEach((key) => { delete s[key]; });
      if (!s.id.startsWith('.')) {
        const childs = s.children;
        delete s.children;
        streams.push(s);
        if (childs) parseTree(childs);
      }
    });
  }
  parseTree(content.streams);
  await uploadInBatch(connection, streams, 'streams');
}

async function restoreEvents (connection, sourcePath) {
  const eventFile = path.join(sourcePath, 'events.json');
  const content = JSON.parse(fs.readFileSync(eventFile, 'utf-8'));
  const standardEvents = [];
  const eventsWithAttachments = [];
  const eventsSeries = [];
  content.events.forEach((e) => {
    ['modified', 'modifiedBy', 'streamId', 'created', 'createdBy'].forEach((key) => { delete e[key]; });
    e.streamIds = e.streamIds.filter((streamId) => { return !streamId.startsWith('.'); }); // remove system streams

    // uncomment the following line to change event Ids, usefull when loading on the same system
    // e.oldId = e.id; e.id = cuid();

    // uncomment the following line to add a delay
    // e.time = e.time + (365 * 24 * 60 * 60 * 2);

    console.log('+', e.time, new Date(e.time * 1000));
    if (e.streamIds.length > 0) {
      if (e.attachments && e.attachments.length > 0) {
        eventsWithAttachments.push(e);
      } else if (e.type.startsWith('series:')) {
        // Plan 72 C.4: keep oldId so we can map it to the new event id after
        // events.create and locate the matching hf-data/<oldId>.json file.
        e.oldId = e.id;
        delete e.id;
        delete e.attachments;
        eventsSeries.push(e);
      } else {
        delete e.oldId;
        delete e.attachments;
        standardEvents.push(e);
      }
    }
  });

  await uploadInBatch(connection, standardEvents, 'events');
  await uploadEventsWithAttachments(connection, eventsWithAttachments, sourcePath);
  // Plan 72 C.4: series events used to be filtered but never restored
  // (eventsSeries was a dead bucket since at least v0.2.x). Now we create
  // the container event AND, if the backup carries the matching
  // hf-data/<oldId>.json, re-upload the data points via the lib's
  // addPointsToHFEvent helper.
  await restoreSeriesEvents(connection, eventsSeries, sourcePath);
}

async function restoreSeriesEvents (connection, seriesEvents, sourcePath) {
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
        continue;
      }
      if (points.length === 0) {
        console.log('HFS data for ' + oldId + ' is empty (0 points)');
        continue;
      }
      await connection.addPointsToHFEvent(newId, fields, points);
      console.log('Restored HFS data for ' + oldId + ' → ' + newId + ' (' + points.length + ' points)');
    } catch (err) {
      console.log('Failed HFS data restore for ' + oldId + ': ' + (err.message || err));
    }
  }
}

async function uploadEventsWithAttachments (connection, eventsWithAttachments, sourcePath) {
  const res = [];
  for (let i = 0; i < eventsWithAttachments.length; i++) {
    const e = eventsWithAttachments[i];
    console.log('Uploading event with attachment ', e.id);
    // Plan 72 C.4: pryv@2.3.3 Connection exposes createEventWithFile only
    // (single-attachment). Multi-attachment events log a warning per skipped
    // file so a restore-side auditor can reconcile against the source.
    // Upgrading to pryv@3+ (multi-attachment via addFileToEvent) would lift
    // this; deferred to a separate backlog item.
    if (e.attachments.length > 1) {
      console.log('WARN: multi-attachment event ' + e.id + ' — only attachment[0] (' +
        e.attachments[0].fileName + ') restored; ' + (e.attachments.length - 1) +
        ' file(s) skipped: ' + e.attachments.slice(1).map(function (a) { return a.fileName; }).join(', '));
    }
    const a = e.attachments[0];
    // console.log(a, e);
    const fileId = e.oldId || e.id;
    delete e.attachments;
    delete e.oldId;
    const filepath = path.join(sourcePath, 'attachments', fileId + '_' + a.fileName);
    try {
      const result = await connection.createEventWithFile(e, filepath);
      res.push(result);
    } catch (e) {
      if (e.response && e.response.body) {
        res.push(e.response.body);
      } else {
        res.push('' + e);
      }
    }
  }
  fs.writeFileSync('res_attachments.log', JSON.stringify(res, null, 2));
}

async function uploadInBatch (connection, data, ressource) {
  const calls = [];
  data.forEach((item) => {
    calls.push({ method: ressource + '.create', params: item });
  });
  const res = await connection.api(calls, (progress) => {
    console.log('Uploading ' + ressource + ' ' + progress + '%');
  });
  fs.writeFileSync('res_' + ressource + '.log', JSON.stringify(res, null, 2));
}

async function restore (connection, source) {
  await restoreStreams(connection, source);
  await restoreEvents(connection, source);
}

module.exports = restore;
