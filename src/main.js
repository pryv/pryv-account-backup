var pryv = require('Pryv'),
  fs = require('fs'),
  https = require('https'),
  async = require('async'),
  mkdirp = require('mkdirp'),
  read = require('read');




var outDir, attDir, eventsFile;
function createDirs() {
  // humm.. could be better
  outDir = './out/' + settings.username + '.' + settings.domain + '/';
  attDir = outDir + 'attachments/';
  eventsFile = outDir + 'events.json';

  mkdirp(outDir, function (/*err*/) {
    mkdirp(attDir, function (/*err*/) {

      // path was created unless there was error

    });
    // path was created unless there was error

  });
}







// -- go
var  settings = {
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
      settings.domain = domain || 'pryv.me';
      settings.origin = 'https://sw.' + settings.domain;
      done(er);
    });
  },
  function (done) {
    read({ prompt: 'Username : ', silent: false }, function (er, username) {
      settings.username = username;
      done(er);
    });
  },
  function (done) {
    read({ prompt: 'Password : ', silent: true }, function (er, password) {
      settings.password = password;
      done(er);
    });
  },
  function (done) {
    console.log('Connecting to ' + settings.username + '.' + settings.domain);

    createDirs();

    pryv.Connection.login(settings, function (err, conn) {
      if (err) {
        console.log('Connection failed with Error:', err);
        return done(err);
      }
      connection = conn;
      done();
    });
  },
  function (done) {
    console.log('Starting Backup');

    done();
  },
  function (done) {
    async.map(['streams', 'accesses', 'followed-slices', 'profile/public'],
      apiToJSONFile, function (err) { 
      done(err);
    });
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});




function saveToFile(key, myData) {
  var outputFilename = key.replace('/', '_') + '.json';
  fs.writeFile(outDir + outputFilename, JSON.stringify(myData, null, 4), function (err) {
    if (err) {
      console.log(err);
    } else {
      console.log('JSON saved to ' + outDir + outputFilename);
    }
  });
}



function getAttachment(att, done) {
  var attFile = attDir + att.eventId + '_' + att.fileName;

  if (fs.existsSync(attFile)) {
    console.log('Skipping: ' + attFile);
    return done();
  }

  var options = {
    host: connection.username + '.' + connection.settings.domain,
    port: settings.port,
    path: '/events/' +
      att.eventId + '/' + att.id + '?readToken=' + att.readToken
  };

  console.log(attFile, options.path);

  https.get(options, function (res) {
    var binData = '';
    res.setEncoding('binary');

    res.on('data', function (chunk) {
      binData += chunk;
    });

    res.on('end', function () {
      fs.writeFile(attFile, binData, 'binary', function (err) {
        if (err) { throw err; }
        console.log('File saved.' + attFile);
        done();
      });
    });
  });


}


function parseEvents(events) {
  var attachments = [];

  events.forEach(function (event) {
    if (event.attachments) {
      event.attachments.forEach(function (att) {
        if (att.id) {
          att.eventId = event.id;
          attachments.push(att);
        } else {
          console.log('att.id missing', event);
        }
      });
    }
  });

  async.mapLimit(attachments, 10, getAttachment, function (error, res) {
    if (error) {
      console.log('################### ERROR', error, '#############');
      return;
    }

    console.log('done');
  });
}


function apiToJSONFile (call, done) {
  console.log('Fetching: ' + call)
  connection.request({
    method: 'GET',
    path: '/' + call,
    callback: function (error, result) {
      if (! error) {
        saveToFile(call,  result);
      }
      done(error);
    },
    progressCallback: function ()  {
      console.log('.');
    }
  });
}


function backupEvents () {

  if (fs.existsSync(eventsFile)) {
    console.log('using local events');
    var result = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    parseEvents(result.events);
  } else {
    console.log('fetching events');
    connection.request('GET', '/events?fromTime=0&toTime=2350373077.359', function (error, result) {
      if (error) {
        console.log(error);
      } else {
        saveToFile('events',  result);
        parseEvents(result.events);
      }
    }, null);
  }
}

