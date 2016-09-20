var pryv = require('Pryv'),
  fs = require('fs'),
  https = require('https'),
  async = require('async'),
  mkdirp = require('mkdirp'),
  read = require('read');

var exporter = {};

module.exports = exporter;

var outDir, attDir, eventsFile;
function createDirs() {
  // humm.. could be better
  outDir = './out/' + authSettings.username + '.' + authSettings.domain + '/';
  attDir = outDir + 'attachments/';
  eventsFile = outDir + 'events.json';

  mkdirp(outDir, function (err) {
    mkdirp(attDir, function (err2) {
      if (err2) { console.log('Failed creating ' + attDir, err2); process.exit(0);}
    });
    if (err) { console.log('Failed creating ' + outDir, err); process.exit(0);}
  });
}

// -- go
var authSettings = {
    appId: 'pryv-backup',
    username: null,
    auth: null,
    port: 443,
    ssl: true,
    domain: false
  },
  connection = null;


async.series([
  function (done) {
    read({ prompt: 'Domain (default: pryv.me): ', silent: false }, function (er, domain) {
      authSettings.domain = domain || 'pryv.me';
      authSettings.origin = 'https://sw.' + authSettings.domain;
      done(er);
    });
  },
  function (done) {
    read({ prompt: 'Username : ', silent: false }, function (er, username) {
      authSettings.username = username;
      done(er);
    });
  },
  function (done) {
    read({ prompt: 'Password : ', silent: true }, function (er, password) {
      authSettings.password = password;
      done(er);
    });
  },
  function (done) {
    console.log('Connecting to ' + authSettings.username + '.' + authSettings.domain);

    createDirs();

    pryv.Connection.login(authSettings, function (err, conn) {
      if (err) {
        console.log('Connection failed with Error:', err);
        return done(err);
      }
      connection = conn;
      done();
    });
  },
  function (done) {
    if (fs.existsSync(eventsFile)) {
      read({ prompt: eventsFile + ' exists, restart attachments sync only?\n' +
        '[N] will delete current events.json file and backup everything Y/N ? (default Y)',
        silent: false }, function (er, resetQ) {
        if (resetQ.toLowerCase() === 'n') {
          fs.unlinkSync(eventsFile);
          console.log('Full backup restart');
        }
        done(er);
      });
    }  else {
      done();
    }
  },
  function (done) {
    read({ prompt: 'Also fetch trashed data? Y/N (default N) : ', silent: false },
      function (er, res) {
      authSettings.includeTrashed = (res.toLowerCase() === 'y');
      done(er);
    });
  },
  function (done) {
    read({ prompt: 'Also fetch attachment files? Y/N (default N) : ', silent: false },
      function (er, res) {
        authSettings.includeAttachments = (res.toLowerCase() === 'y');
        done(er);
      });
  },
  function (done) {
    console.log('Starting Backup');

    done();
  },
  function (done) {
    if (fs.existsSync(eventsFile)) { // skip
      return done();
    }

    var eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000;
    var streamsRequest = 'streams';
    if (authSettings.includeTrashed) {
      eventsRequest += '&state=all';
      streamsRequest += '?&state=all';
    }

    async.mapSeries(['account', streamsRequest, 'accesses',
      'followed-slices', 'profile/public', eventsRequest],
      apiToJSONFile, function (err) { 
      done(err);
    });
  },
  function (stepDone) {
    if (authSettings.includeAttachments) {
      downloadAttachments(eventsFile, stepDone);
    } else {
      console.log('skipping attachments');
      stepDone();
    }
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});

/**
 * Downloads the requested Pryv API resource and saves it to a local file
 *
 * @param resource
 * @param callback
 */
function apiToJSONFile(resource, callback) {
  console.log('Fetching: ' + resource);
  connection.request({
    method: 'GET',
    path: '/' + resource,
    callback: function (error, result) {
      if (error) {
        console.log('Failed: ' + resource);
        return callback(error);
      }
      saveToFile(resource,  result, callback);
    }
  });
}

/**
 * Saves the data to a JSON file under the name `resource.json` (spaces are converted to
 * underscores).
 *
 * @param resourceName
 * @param jsonData
 * @param callback
 */
function saveToFile(resourceName, jsonData, callback) {
  var outputFilename = resourceName.replace('/', '_').split('?')[0] + '.json';
  fs.writeFile(outDir + outputFilename, JSON.stringify(jsonData, null, 4), function (err) {
    if (err) {
      console.log(err);
    } else {
      console.log('JSON saved to ' + outDir + outputFilename);
    }
    callback(err);
  });
}


/**
 * Parses the events from the provided file and downloads their attachments
 *
 * @param eventsFile
 * @param callback
 */
function downloadAttachments(eventsFile, callback) {
  var events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
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

  // Download attachment files 10 by 10
  async.mapLimit(attachments, 10, getAttachment, function (error, res) {
    if (error) {
      console.log('################### ERROR', error, '#############');
      return;
    }

    console.log('done');
  }, function (err) {
    callback(err);
  });
}


/**
 * Download attachment file and save it on local storage under
 * {eventId_attachmentFileName}.
 * If the file already exists, it is skipped
 *
 * @param attachment
 * @param callback
 */
function getAttachment(attachment, callback) {
  var attFile = attDir + attachment.eventId + '_' + attachment.fileName;

  if (fs.existsSync(attFile)) {
    console.log('Skipping: ' + attFile);
    return callback();
  }

  var options = {
    host: connection.username + '.' + connection.settings.domain,
    port: authSettings.port,
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
