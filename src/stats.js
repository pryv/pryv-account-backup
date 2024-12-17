/**
 * Get stats of over a backup
 */

const fs = require('fs');
const path = require('path');

const context = {};
// check BackupDirectory
if (process.argv[2]) {
  context.eventsFile = path.join(process.argv[2], 'events.json');
  context.streamsFile = path.join(process.argv[2], 'streams.json');
  if (!fs.existsSync(context.eventsFile)) { // skip
    console.log('Directory [' + process.argv[2] + '] is not a valid directory');
    process.exit(0);
  } else {
    context.backupSource = process.argv[2];
  }
}

const events = JSON.parse(fs.readFileSync(context.eventsFile, 'utf-8')).events;
const stats = {
  minDate: Number.MAX_SAFE_INTEGER,
  maxDate: 0,
  eventsCount: events.length,
  streamsCount: 0
}

for (const event of events) {
  if (event.time < stats.minDate) stats.minDate = event.time;
  if (event.time > stats.maxDate) stats.maxDate = event.time;
}

const streams = JSON.parse(fs.readFileSync(context.streamsFile, 'utf-8')).streams;
function inspectStream (streamsArray) {
  if (!streamsArray || streamsArray.length === 0) return [];
  stats.streamsCount += streamsArray.length;
  for (const stream of streamsArray) {
    inspectStream(stream.children);
  }
}
inspectStream(streams);

stats.diffMaxMsToNow = Date.now() - (stats.maxDate * 1000);
stats.minDate = new Date(stats.minDate * 1000).toDateString();
stats.maxDate = new Date(stats.maxDate * 1000).toDateString();

console.log(stats);
