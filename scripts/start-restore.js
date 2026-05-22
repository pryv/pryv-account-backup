const fs = require('fs');
const path = require('path');
const async = require('async');
const read = require('read');
const pryv = require('pryv');
const restore = require('../src/restore.js');
const context = {};

// read v5+ returns a Promise instead of taking a callback. Wrap so the existing
// async.series chain stays intact without rewriting the script.
function readP (opts, callback) {
  read(opts).then((value) => callback(null, value)).catch(callback);
}

// check BackupDirectory
if (process.argv[2]) {
  if (!fs.existsSync(path.join(process.argv[2], 'events.json'))) { // skip
    console.log('Directory [' + process.argv[2] + '] is not a valid directory');
  } else {
    context.backupSource = process.argv[2];
  }
}

if (!context.backupSource) {
  console.log('Usage: node scripts/start-restore.js <pathToDirectory>');
  process.exit(0);
}

async.series([
  function inputServiceInfo(done) {
    readP({ prompt: 'Service info URL: ', silent: false }, function (err, serviceInfoUrl) {
      if (!serviceInfoUrl || serviceInfoUrl.trim().length === 0) {
        serviceInfoUrl = 'https://reg.pryv.me/service/info';
        console.log('Using default serviceInfoUrl: ' + serviceInfoUrl);
      }
      context.service = new pryv.Service(serviceInfoUrl);
      done(err);
    });
  },
  function checkServiceInfo (done) {
    context.service.info().then(function (result, err) {
      context.info = result;
      console.log('Ready to login service: ' + context.info.name);
      done(err);
    });
  }
  , function inputUsername (done) {
    readP({ prompt: 'Username : ', silent: false }, function (err, username) {
      context.username = username;
      done(err);
    });
  },
  function inputPassword (done) {
    readP({ prompt: 'Password : ', silent: true }, function (err, password) {
      context.password = password;
      done(err);
    });
  },
  function login (done) {
    context.service.login(context.username, context.password, 'restore-bkp').then(function (connection, err) {
      context.connection = connection;
      done(err);
    });
  },
  function doRestore (done) {
    console.log('starting restore');
    restore(context.connection, context.backupSource).then(function (result, err) {
      done(err);
    });
  }
], function (err) {
  if (err) {
    console.log('Failed in process with error', err);
  }
});
