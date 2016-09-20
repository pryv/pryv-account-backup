var backup = require('../../src/main'),
    testUser = require('../helpers/testuser');


describe('file-structure', function () {

  it('should create the correct folder and files', function (done) {

    var settings = {
      username: testUser.credentials.username,
      domain: testUser.credentials.domain,
      password: testUser.credentials.password,
      includeTrashed: true,
      includeAttachments: true
    };
    settings.backupDirectory = new backup.Directory(settings.username, settings.domain);

    backup.start(settings, function (err) {
      if (err) {
        return done(err);
      }
      done();
    })
  });
});