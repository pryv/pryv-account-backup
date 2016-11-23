var async = require('async'),
    fs = require('fs'),
    https = require('https');

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
  var events = JSON.parse(fs.readFileSync(backupDir.eventsFile, 'utf8'));
  var attachments = [];
  log('Start attachments download.');
  // gather attachments
  events.events.forEach(function (event) {
    if (event.attachments) {
      event.attachments.forEach(function (att) {
        if (att.id) {
          att.eventId = event.id;
          attachments.push(att);
        } else {
          log('Invalid event: att.id is missing: ' + event);
        }
      });
    }
  });

  // Download attachment files in 10 parralel calls
  async.mapLimit(attachments, 10, function (item, callback) {
    getAttachment(connection, backupDir.attachmentsDir, item, callback, log);
  }, function (error) {
    if (error) {
      log('Error while downloading the attachments: ' + error);
      return;
    }
    log('Download done');
    callback();
  });
};


/**
 * Download attachment file and save it on local storage under
 * {eventId_attachmentFileName}.
 * If the file already exists, it is skipped
 *
 * @param attachmentsDir
 * @param attachment
 * @param callback
 */
function getAttachment(connection, attachmentsDir, attachment, callback, log) {
  var attFile = attachmentsDir + attachment.eventId + '_' + attachment.fileName;

  if (fs.existsSync(attFile)) {
    log('Skipping already existing attachment: ' + attFile);
    return callback();
  }

  var options = {
    host: connection.username + '.' + connection.settings.domain,
    port: connection.settings.port,
    path: '/events/' +
    attachment.eventId + '/' + attachment.id + '?readToken=' + attachment.readToken
  };

  https.get(options, function (res) {
    var binData = '';
    res.setEncoding('binary');

    res.on('data', function (chunk) {
      binData += chunk;
    });

    res.on('end', function () {
      fs.writeFile(attFile, binData, 'binary', function (err) {
        if (err) {
          log('Error while writing attachment: ' + attFile);
          throw err;
        }
        log('Attachment saved: ' + attFile);
        callback();
      });
    });

  }).on('error', function (e) {
    log('Error while fetching https://' + options.host + options.path);
    callback(e);
  });
}