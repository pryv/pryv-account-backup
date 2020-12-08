const Pryv = require('pryv');
const fs = require('fs');
const path = require('path');
const { startsWith } = require('lodash');

async function restoreStreams(connection, sourcePath) {
  const ressourceFile = path.join(sourcePath, 'streams.json');
  const content = JSON.parse(fs.readFileSync(ressourceFile, 'utf-8'));
  const streams = [];

  function parseTree(streamList) {
    streamList.map((s) => { 
      ['modified', 'modifiedBy', 'created', 'createdBy'].map((key) => { delete s[key]});
      if (! s.id.startsWith('.')) {
        const childs = s.children;
        delete s.children;
        streams.push(s);
        if (childs) parseTree(childs);
      }
    });
  }
  parseTree(content.streams);
  uploadInBatch(connection, streams, 'streams');
}


async function restoreEvents(connection, sourcePath) {
  const eventFile = path.join(sourcePath, 'events.json');
  const content = JSON.parse(fs.readFileSync(eventFile, 'utf-8'));
  const standardEvents = [];
  const eventsWithAttachments = [];
  const eventsSeries = [];
  content.events.map((e) => { 
    ['modified', 'modifiedBy', 'streamId', 'created', 'createdBy'].map((key) => { delete e[key]});
    e.streamIds = e.streamIds.filter((streamId) => { return ! streamId.startsWith('.')}); // remove system streams
    if (e.streamIds.length > 0) {
      if (e.attachments && e.attachments.length > 0) {
        eventsWithAttachments.push(e);
      } else if (e.type.startsWith('series:')) { 
        delete e.attachments;
        eventsSeries.push(e);
      } else {
        delete e.attachments;
        standardEvents.push(e);
      }
    }
  });
  
  console.log(eventFile, content.events.length, eventsWithAttachments.length, standardEvents.length, standardEvents[1]);
  uploadInBatch(connection, standardEvents, 'events');
}

async function uploadInBatch(connection, data, ressource) {
  const calls = [];
  data.map((item) => { 
    calls.push({method: ressource + '.create', params: item});
  });
  const res = await connection.api(calls, (progress) => { 
    console.log('Uploading ' + ressource + ' ' + progress + '%');
  });
  fs.writeFileSync('res' + ressource + '.log', JSON.stringify(res, null, 2));
};

async function checkSource(sourcePath) {

}

const source = '/tmp/backupPY/marianne.pryv.me_';
const ressource = 'events';


(async () => {
  const service = new Pryv.Service('https://reg.pryv.me/service/info');
  const connection = await service.login('testup','testup', 'bkp-test');
  await restoreStreams(connection, source);
  await restoreEvents(connection, source);
})();