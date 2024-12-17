/**
 * Remove unused streams from a backup
 */

const fs = require('fs');
const path = require('path');

const context = {};

// check BackupDirectory
if (process.argv[2]) {
  context.eventsFile = path.join(process.argv[2], 'events.json');
  context.streamsFile = path.join(process.argv[2], 'streams.json');
  context.streamsStrippedFile = path.join(process.argv[2], 'streams-stripped.json');
  if (!fs.existsSync(context.eventsFile)) { // skip
    console.log('Directory [' + process.argv[2] + '] is not a valid directory');
    process.exit(0);
  } else {
    context.backupSource = process.argv[2];
  }
}

const events = JSON.parse(fs.readFileSync(context.eventsFile, 'utf-8')).events;
context.foundStreamsMap = {};
for (const event of events) {
  for (const streamId of event.streamIds) {
    context.foundStreamsMap[streamId] = true;
  }
}

console.log('Found ' + Object.keys(context.foundStreamsMap).length + ' streams');

const streams = JSON.parse(fs.readFileSync(context.streamsFile, 'utf-8')).streams;

const streamsControlMap = Object.assign({}, context.foundStreamsMap);
function inspectStream (streamsArray) {
  if (!streamsArray || streamsArray.length === 0) return [];
  const result = [];
  for (const stream of streamsArray) {
    stream.children = inspectStream(stream.children);
    if (context.foundStreamsMap[stream.id]) {
      delete streamsControlMap[stream.id];
    }
    if (stream.children.length > 0 || context.foundStreamsMap[stream.id]) {
      result.push(stream);
    }
  }
  return result;
}
const streamsResult = inspectStream(streams);

console.log('Did not  found ' + Object.keys(streamsControlMap) + ' streams');

fs.writeFileSync(context.streamsStrippedFile, JSON.stringify({ streams: streamsResult }, null, 2));
console.log('Result saved in file: ' + context.streamsStrippedFile);
