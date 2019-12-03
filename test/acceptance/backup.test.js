/*global describe, it, before, after */

const backup = require('../../src/main');
const testuser = require('../helpers/testuser');
const credentials = testuser.credentials;
const async = require('async');
const fs = require('fs');
const should = require('should');
const superagent = require('superagent');

describe('backup', function () {

  this.timeout(10000);

  let settings = null;
  let resources = null;
  let apiUrl = null;
  let connection = null;

  before(function (done) {
    const domain = testuser.extractDomain(credentials.serviceInfoUrl);
    settings = {
      username: credentials.username,
      domain: domain,
      serviceInfoUrl: credentials.serviceInfoUrl,
      password: credentials.password,
      includeTrashed: true,
      includeAttachments: true,
      appId: 'pryv-backup'
    };

    settings.origin = 'https://sw.' + settings.domain;
    settings.backupDirectory = new backup.Directory(settings.username, settings.domain);

    const eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';
    const streamsRequest = 'streams?state=all';
    resources = ['account', streamsRequest, 'accesses', 'followed-slices', 'profile/public', eventsRequest];

    backup.signInToPryv(settings, (err, conn) => {
      connection = conn;
      apiUrl = connection.apiUrl;
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
                superagent.get(apiUrl + resource)
                  .set('Authorization', connection.auth)
                  .then(result => {
                    let outputFilename = resource.replace('/', '_').split('?')[0];
                    const json = JSON.parse(fs.readFileSync(settings.backupDirectory.baseDir + outputFilename + '.json', 'utf8'));

                    if (outputFilename === 'followed-slices') {
                      outputFilename = 'followedSlices';
                    } else if (outputFilename === 'profile_public') {
                      outputFilename = 'profile';
                    }
                    
                    
                    if(outputFilename === 'accesses') {
                      const expected = json[outputFilename];
                      const actual = result.body[outputFilename];
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
                    callback();
                  })
                  .catch(error => {
                    return callback(error);
                  });
              }, stepDone);
        }
    ], function(err) {
      should.not.exist(err);
      done(err);
    });
  });
});