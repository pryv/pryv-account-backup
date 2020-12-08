const Pryv = require('pryv');
const fs = require('fs');
const path = require('path');

async function restoreStreams(connection, sourcePath) {
  const ressourceFile = path.join(sourcePath, 'streams.json');
  const content = JSON.parse(fs.readFileSync(ressourceFile, 'utf-8'));
  const streams = [];

  function parseTree(streamList) {
    streamList.map((s) => {
      ['modified', 'modifiedBy', 'created', 'createdBy'].map((key) => { delete s[key] });
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


async function restoreEvents(connection, sourcePath) {
  const eventFile = path.join(sourcePath, 'events.json');
  const content = JSON.parse(fs.readFileSync(eventFile, 'utf-8'));
  const standardEvents = [];
  const eventsWithAttachments = [];
  const eventsSeries = [];
  content.events.map((e) => {
    ['modified', 'modifiedBy', 'streamId', 'created', 'createdBy'].map((key) => { delete e[key] });
    e.streamIds = e.streamIds.filter((streamId) => { return !streamId.startsWith('.') }); // remove system streams
    if (e.streamIds.length > 0) {
      if (e.attachments && e.attachments.length > 0) {
        eventsWithAttachments.push(e);
      } else if (e.type.startsWith('series:')) {
        delete e.attachments;
        eventsSeries.push(e);
      } else {
        delete e.attachments;
        standardEvents.push(e);
      }
    }
  });

  await uploadInBatch(connection, standardEvents, 'events');
  await uploadEventsWithAttachments(connection, eventsWithAttachments, sourcePath);
}


async function uploadEventsWithAttachments(connection, eventsWithAttachments, sourcePath) {
  const res = [];
  for (let i = 0; i < eventsWithAttachments.length; i++) {
    const e = eventsWithAttachments[i];
    console.log('Uploading event with attachment ', e.id);
    if (e.attachments.length > 1) { console.log('Ignored 2nd attachment for event : ' + e.id); }
    const a = e.attachments[0];
   // console.log(a, e);
    delete e.attachments;
    const filepath = path.join(sourcePath, 'attachments', e.id + '_' + a.fileName);
    try { 
      const result = await connection.createEventWithFile(e, filepath);
      res.push(result);
    } catch (e) {
      if (e.response && e.response.body) {
        res.push(e.response.body);
      } else {
        res.push('' + e);
      }
    }
  }
  //fs.writeFileSync('res_attachments.log', JSON.stringify(res, null, 2));
}

async function uploadInBatch(connection, data, ressource) {
  const calls = [];
  data.map((item) => {
    calls.push({ method: ressource + '.create', params: item });
  });
  const res = await connection.api(calls, (progress) => {
    console.log('Uploading ' + ressource + ' ' + progress + '%');
  });
  //fs.writeFileSync('res_' + ressource + '.log', JSON.stringify(res, null, 2));
};

async function checkSource(sourcePath) {

}

async function restore(connection, source) {
await restoreStreams(connection, source);
 await restoreEvents(connection, source);
}

module.exports = restore;

  