const async = require('async');
const fs = require('fs');
const path = require('path');
const https = require('https');
const JSONStream = require('JSONStream');
const mkdirp = require('mkdirp');

/**
 * Parses the events from the provided file and downloads their attachments
 *
 * @param connection {pryv.Connection}
 * @param backupDir {backup-directory}
 * @param callback
 */
exports.download = function (connection, backupDir, callback, log) {
  if (!log) {
    log = console.log;
  }

  loadStreamMapIfNeed(backupDir, log);

  loadEventFile(connection, backupDir, function (error, attachments) {
    if (error) {
      log('Failed parsing event file for attachments' + error);
      return callback(error);
    }

    // Download attachment files in 10 parralel calls
    async.mapLimit(attachments, 10, function (item, callback) {
      getAttachment(connection, backupDir, item, callback, log);
    }, function (error) {
      if (error) {
        log('Error while downloading the attachments: ' + error);
        callback(error);
        return;
      }
      log('Download done');
      callback();
    });

  }, log);

};

/**
 * Create a map
 * @param {*} backupDir 
 * @param {*} log 
 * @returns 
 */
function loadStreamMapIfNeed(backupDir, log) {
  if (! backupDir.settingAttachmentUseStreamsPath) return;
  log('Loading streams Dir');
  try {
    const streamsTree = JSON.parse(fs.readFileSync(backupDir.streamsFile, 'utf8')) ;
    function mapTree(childs, path) {
      for (const child of childs) {
        const childPath = path + '/' + child.name.replaceAll('..','__'); // escape all ".."
        backupDir.streamsMap[child.id] = childPath;
        if (child.childrens) mapTree(child.childrens, childPath);
      }
    }
    mapTree(streamsTree.streams, '');
  } catch (error) {
    log('Error while reading streams: ' + error);
  }
}

function loadEventFile(connection, backupDir, callback, log) {
  const attachments = [];
  log('Parsing events for attachments');

  // --- pretty timed log ---//
  const timeRepeat = 1000;
  let total = 0;
  let done = false;
  const timeLog = function() {
    if (done) return;
    log('Parsed ' +  total + ' events, found ' + attachments.length + ' attachments');
    setTimeout(timeLog, timeRepeat);
  }
  setTimeout(timeLog, timeRepeat);

  fs.createReadStream(backupDir.eventsFile, 'utf8').pipe(
    JSONStream.parse('events.*').on('data', function(event) {
      total++;
      if (event.attachments) {
        event.attachments.forEach(function (att) {
          if (att.id) {
            att.eventId = event.id;
            att.streamId = event.streamId;
            attachments.push(att);
          } else {
            log('Invalid event: att.id is missing: ' + event);
          }
        });
      }
  }).on('error', function(error) {
      done = true;
      log('Error while fetching attachments: ' + error)
      callback(error, attachments);
    }).on('end', function() {
      done = true;
      log('Found ' + attachments.length + ' attachments');
      callback(null, attachments);
    }));
}


/**
 * Download attachment file and save it on local storage under
 * {eventId_attachmentFileName}.
 * If the file already exists, it is skipped
 *
 * @param attachmentsDir
 * @param attachment
 * @param callback
 */
async function getAttachment(connection, backupDir, attachment, callback, log) {
  const attachmentsDir = backupDir.attachmentsDir
  const attName = attachment.eventId + '_' + attachment.fileName;
  let attFile = attachmentsDir + attName;
  if (backupDir.settingAttachmentUseStreamsPath) {
    let streamPath = backupDir.streamsMap[attachment.streamId];
    if (streamPath) {
      const attPath = path.resolve(attachmentsDir + streamPath);
      await mkdirp(attPath);
      attFile = attPath + '/' + attName;
    }
  }

  if (fs.existsSync(attFile)) {
    log('Skipping already existing attachment: ' + attFile);
    return callback();
  }

  const url = new URL(connection.endpoint)

  const options = {
    host: url.hostname,
    port: url.port || 443,
    path: url.pathname + 'events/' +
    attachment.eventId + '/' + attachment.id + '?readToken=' + attachment.readToken
  };

  https.get(options, function (res) {
    let binData = '';
    res.setEncoding('binary');

    res.on('data', function (chunk) {
      binData += chunk;
    });

    res.on('end', function () {
      fs.writeFile(attFile, binData, 'binary', function (err) {
        if (err) {
          log('Error while writing attachment: ' + attName);
          throw err;
        }
        log('Attachment saved: ' + attName);
        callback();
      });
    });

  }).on('error', function (e) {
    log('Error while fetching https://' + options.host + options.path);
    callback(e);
  });
}
