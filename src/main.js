var pryv = require('Pryv'),
  fs = require('fs'),
  https = require('https'),
  async = require('async'),
  mkdirp = require('mkdirp'),
  read = require('read');

// TODO will modularize this
var exporter = {};
module.exports = exporter;

var filesAndFolder = {
  outDir: '',
  attDir: '',
  eventsFile: ''
};

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
  function inputDomain(done) {
    read({prompt: 'Domain (default: pryv.me): ', silent: false}, function (er, domain) {
      authSettings.domain = domain || 'pryv.me';
      authSettings.origin = 'https://sw.' + authSettings.domain;
      done(er);
    });
  },
  function inputUsername(done) {
    read({prompt: 'Username : ', silent: false}, function (er, username) {
      authSettings.username = username;
      done(er);
    });
  },
  function inputPassword(done) {
    read({prompt: 'Password : ', silent: true}, function (er, password) {
      authSettings.password = password;
      done(er);
    });
  },
  function createDirectoryTree(done) {
    createDirs(filesAndFolder, done);
  },
  function signInToPryv(done) {
    console.log('Connecting to ' + authSettings.username + '.' + authSettings.domain);

    pryv.Connection.login(authSettings, function (err, conn) {
      if (err) {
        console.log('Connection failed with Error:', err);
        return done(err);
      }
      connection = conn;
      done();
    });
  },
  function promptOverwriteEvents(done) {
    if (fs.existsSync(filesAndFolder.eventsFile)) {
      read({
        prompt: filesAndFolder.eventsFile + ' exists, restart attachments sync only?\n' +
        '[N] will delete current events.json file and backup everything Y/N ? (default Y)',
        silent: false
      }, function (err, resetQ) {
        if (resetQ.toLowerCase() === 'n') {
          fs.unlinkSync(filesAndFolder.eventsFile);
          console.log('Full backup restart');
        }
        done(err);
      });
    } else {
      done();
    }
  },
  function promptIncludeTrashed(done) {
    read({prompt: 'Also fetch trashed data? Y/N (default N) : ', silent: false},
      function (er, res) {
        authSettings.includeTrashed = (res.toLowerCase() === 'y');
        done(er);
      });
  },
  function promptIncludeAttachments(done) {
    read({prompt: 'Also fetch attachment files? Y/N (default N) : ', silent: false},
      function (er, res) {
        authSettings.includeAttachments = (res.toLowerCase() === 'y');
        done(er);
      });
  },
  function (done) {
    console.log('Starting Backup');

    // TODO we skip all info if events are skipped - need more granularity
    if (fs.existsSync(filesAndFolder.eventsFile)) { // skip
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
      function (resource, callback) {
        apiToJSONFile(filesAndFolder.outDir, resource, callback)
      }, function (err) {
        done(err);
      });
  },
  function downloadAttachments(stepDone) {
    if (authSettings.includeAttachments) {
      downloadAttachments(filesAndFolder.eventsFile, stepDone);
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
 * Creates the following directory tree in the current folder:
 * out/
 *  username.domain/
 *    events.json
 *    attachments/
 *
 * @param options {object}
 *        options.outDir
 *        options.eventsFile
 *        options.attDir
 */
function createDirs(options, callback) {
  // humm.. could be better
  options.outDir = './out/' + authSettings.username + '.' + authSettings.domain + '/';
  options.attDir = options.outDir + 'attachments/';
  options.eventsFile = options.outDir + 'events.json';

  mkdirp(options.outDir, function (err) {
    if (err) {
      console.log('Failed creating ' + options.outDir, err)
      // process.exit(0);
      callback(err);
    }

    mkdirp(options.attDir, function (err2) {
      if (err2) {
        console.log('Failed creating ' + options.attDir, err2);
        // process.exit(0);
        callback(err2);
      }
      callback();
    });
  });
}

/**
 * Downloads the requested Pryv API resource and saves it to a local file
 *
 * @param resource
 * @param callback
 */
function apiToJSONFile(folder, resource, callback) {
  console.log('Fetching: ' + resource);
  connection.request({
    method: 'GET',
    path: '/' + resource,
    callback: function (error, result) {
      if (error) {
        console.log('Failed: ' + resource);
        return callback(error);
      }
      saveToFile(folder, resource, result, callback);
    }
  });
}

/**
 * Saves the data to a JSON file under the name `resource.json` (spaces are converted to
 * underscores) in the provided folder.
 *
 * @param folder
 * @param resourceName
 * @param jsonData
 * @param callback
 */
function saveToFile(folder, resourceName, jsonData, callback) {
  console.log('saving to folder: ', folder);
  var outputFilename = resourceName.replace('/', '_').split('?')[0] + '.json';
  fs.writeFile(folder + outputFilename, JSON.stringify(jsonData, null, 4), function (err) {
    if (err) {
      console.error(err);
    } else {
      console.log('JSON saved to ' + folder + outputFilename);
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
  var attFile = attachmentsDirectory + attachment.eventId + '_' + attachment.fileName;

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
