/**
 * Change the dates in the backup
 */

const fs = require('fs');
const path = require('path');

const context = {};

function exit(msg) {
  console.error('Error:' + msg);
  console.log('Usage node src/change-dates.js <directory> <deltaTimeInSeconds>');
  process.exit(0);
}

// check BackupDirectory
if (process.argv[2]) {
  context.dir = path.join(process.argv[2]);
  context.eventsFile = path.join(context.dir, 'events.json');
  context.streamsFile = path.join(context.dir, 'streams.json');
  if (!fs.existsSync(context.eventsFile)) { // skip
    exit('Directory [' + context.dir + '] is not a valid directory');
   
  } else {
    context.backupSource = context.dir;
  }
  const deltaTime = Number.parseInt(process.argv[3]);
  if (!deltaTime || isNaN(deltaTime)) {
   exit('Second argument must be ');
  }
  context.deltaTime = deltaTime;
}

const stats = {
  minDate: Number.MAX_SAFE_INTEGER,
  maxDate: 0,
}

const events = JSON.parse(fs.readFileSync(context.eventsFile, 'utf-8')).events;

for (const event of events) {
  event.time += context.deltaTime;
  console.log(event.time, context.deltaTime);
  if (event.time < stats.minDate) stats.minDate = event.time;
  if (event.time > stats.maxDate) stats.maxDate = event.time;
}

stats.minDate = new Date(stats.minDate * 1000).toDateString();
stats.maxDate = new Date(stats.maxDate * 1000).toDateString();

const fsOutputFile = path.join(context.dir, 'events-delta.json');
fs.writeFileSync(fsOutputFile, JSON.stringify({ events }, null, 2));
console.log('Events with delta saved as: ' + fsOutputFile);
console.log(stats);