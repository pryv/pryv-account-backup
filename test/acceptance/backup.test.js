/*global describe, it, before, after */

var backup = require('../../src/main'),
    credentials = require('../helpers/testuser').credentials,
    async = require('async'),
    fs = require('fs'),
    should = require('should'),
    pryv = require('pryv'),
    _ = require('lodash');

describe('backup', function () {

  this.timeout(10000);

  var settings = null,
      resources = null,
      connection = null;

  before(function (done) {
    settings = {
      username: credentials.username,
      domain: credentials.domain,
      password: credentials.password,
      includeTrashed: true,
      includeAttachments: true,
      appId: 'pryv-backup'
    };

    settings.origin = 'https://sw.' + settings.domain;
    settings.backupDirectory = new backup.Directory(settings.username, settings.domain);

    var eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';
    var streamsRequest = 'streams?state=all';
    resources = ['account', streamsRequest, 'followed-slices', 'profile/public', eventsRequest];

    pryv.Connection.login(settings, function (err, conn) {
      connection = conn;
      done(err);
    });
  });

  after(function (done) {
   settings.backupDirectory.deleteDirs(done);
  });

  it('should backup the correct folders and files', function (done) {
    async.series([
        function startBackup(stepDone) {
          backup.start(settings, stepDone);
        },
        function checkFiles(stepDone) {
          resources.forEach(function(resource){
            var outputFilename = resource.replace('/', '_').split('?')[0] + '.json';
            fs.existsSync(settings.backupDirectory.baseDir + outputFilename).should.equal(true);
          });
          stepDone();
        },
        function checkAttachments(stepDone) {
          var events = JSON.parse(fs.readFileSync(settings.backupDirectory.eventsFile, 'utf8'));
          events.events.forEach(function (event) {
            if (event.attachments) {
              event.attachments.forEach(function (att) {
                var attFile = settings.backupDirectory.attachmentsDir + event.id + '_' + att.fileName;
                fs.existsSync(attFile).should.equal(true);
              });
            }
          });
          stepDone();
        },
        function checkContent(stepDone) {
          async.each(resources,
              function (resource, callback) {
                connection.request({
                  method: 'GET',
                  path: '/' + resource,
                  callback: function (error, result) {
                    if(error) {
                      return callback(error);
                    }

                    var outputFilename = resource.replace('/', '_').split('?')[0];
                    var json = JSON.parse(fs.readFileSync(settings.backupDirectory.baseDir + outputFilename + '.json', 'utf8'));

                    if (outputFilename === 'followed-slices') {
                      outputFilename = 'followedSlices';
                    } else if (outputFilename === 'profile_public') {
                      outputFilename = 'profile';
                    }

                    JSON.stringify(result[outputFilename]).should.equal(JSON.stringify(json[outputFilename]));
                    callback();
                  }
                });
              }, stepDone);
        }
    ], function(err) {
      should.not.exist(err);
      done(err);
    });
  });
});