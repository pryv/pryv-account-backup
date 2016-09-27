/*global describe, it, before, after */

var backup = require('../../src/main'),
    testUser = require('../helpers/testuser'),
    async = require('async'),
    fs = require('fs'),
    should = require('should');

describe('backup', function () {

  var settings = null,
      resources = null;

  before(function (done) {
    settings = {
      username: testUser.credentials.username,
      domain: testUser.credentials.domain,
      password: testUser.credentials.password,
      includeTrashed: true,
      includeAttachments: true
    };

    settings.backupDirectory = new backup.Directory(settings.username, settings.domain);
    resources = ['account', 'streams', 'accesses', 'followed-slices', 'profile_public', 'events'];
    done();
  });

  after(function (done) {
    settings.backupDirectory.deleteDirs(done);
  });

  it('should backup the correct folder and files', function (done) {
    async.series([
        function startBackup(stepDone) {
          backup.start(settings, stepDone);
        },
        function checkFiles(stepDone) {
          resources.forEach(function(resource){
            fs.existsSync(settings.backupDirectory.baseDir + resource +'.json').should.equal(true);
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
        }
    ], function(err) {
      should.not.exist(err);
      done(err);
    });
  });
});