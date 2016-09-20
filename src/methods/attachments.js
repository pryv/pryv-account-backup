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
exports.download = function (connection, backupDir, callback) {
  var events = JSON.parse(fs.readFileSync(backupDir.eventsFile, 'utf8'));
  var attachments = [];

  // gather attachments
  events.events.forEach(function (event) {
    if (event.attachments) {
      event.attachments.forEach(function (att) {
        if (att.id) {
          att.eventId = event.id;
          attachments.push(att);
        } else {
          console.error('att.id missing', event);
        }
      });
    }
  });

  // Download attachment files in 10 parralel calls
  async.mapLimit(attachments, 10, function (item, callback) {
    getAttachment(connection, backupDir.attachmentsDir, item, callback);
  }, function (error) {
    if (error) {
      console.error('################### ERROR', error, '#############');
      return;
    }
    console.log('done');
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
function getAttachment(connection, attachmentsDir, attachment, callback) {
  var attFile = attachmentsDir + attachment.eventId + '_' + attachment.fileName;

  if (fs.existsSync(attFile)) {
    console.log('Skipping: ' + attFile);
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
          console.log('Error while writing ' + attFile);
          throw err;
        }
        console.log('File saved.' + attFile);
        callback();
      });
    });

  }).on('error', function (e) {
    console.log('Error while fetching https://' + options.host + options.path, e);
    callback(e);
  });
}