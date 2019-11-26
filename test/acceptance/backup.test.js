/*global describe, it, before, after */

const backup = require('../../src/main');
const credentials = require('../helpers/testuser').credentials;
const async = require('async');
const fs = require('fs');
const should = require('should');
const pryv = require('pryv');

describe('backup', function () {

  this.timeout(10000);

  let settings = null;
  let resources = null;
  let connection = null;

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

    let eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';
    let streamsRequest = 'streams?state=all';
    resources = ['account', streamsRequest, 'accesses', 'followed-slices', 'profile/public', eventsRequest];

    pryv.Connection.login(settings, function (err, conn) {
      connection = conn;
      settings.backupDirectory.deleteDirs(done);
    });
  });

  after(function (done) {
   settings.backupDirectory.deleteDirs(done);
  });

  it('should backup the correct folders and files', function (done) {
    const time = Date.now()/1000;
    async.series([
        function startBackup(stepDone) {
          backup.start(settings, stepDone);
        },
        function checkFiles(stepDone) {
          resources.forEach(function(resource){
            const outputFilename = resource.replace('/', '_').split('?')[0] + '.json';
            fs.existsSync(settings.backupDirectory.baseDir + '/' + outputFilename).should.equal(true);
          });
          stepDone();
        },
        function checkAttachments(stepDone) {
          const events = JSON.parse(fs.readFileSync(settings.backupDirectory.eventsFile, 'utf8'));
          events.events.forEach(function (event) {
            if (event.attachments) {
              event.attachments.forEach(function (att) {
                const attFile = settings.backupDirectory.attachmentsDir + '/' + event.id + '_' + att.fileName;
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

                    let outputFilename = resource.replace('/', '_').split('?')[0];
                    const json = JSON.parse(fs.readFileSync(settings.backupDirectory.baseDir + outputFilename + '.json', 'utf8'));

                    if (outputFilename === 'followed-slices') {
                      outputFilename = 'followedSlices';
                    } else if (outputFilename === 'profile_public') {
                      outputFilename = 'profile';
                    }
                    
                    const expected = json[outputFilename];
                    const actual = result[outputFilename];
                    
                    if(outputFilename === 'accesses') {
                      expected.forEach(function (access, i) {
                        // The lastUsed property of the access used by this test
                        // will be updated at login, so we just check that the
                        // recorded time matches approximately (nearest second)
                        // the time at which we started the test.
                        if(access.name === settings.appId && access.type === 'personal') {
                          should((actual[i].lastUsed - time) < 2).be.true();
                          delete access.lastUsed;
                          delete actual[i].lastUsed;
                        }
                      });
                    }
                    // find a way to test content
                    //JSON.stringify(result[outputFilename]).should.equal(JSON.stringify(json[outputFilename]));
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