/*global describe, it, before, after */

var Directory = require('../../src/methods/backup-directory'),
    credentials = require('../helpers/testuser').credentials,
    fs = require('fs'),
    should = require('should');

describe('backup-directory', function () {

    var BackupDirectory = null;

    before(function (done) {
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        require('../helpers/clear-backup-dir')('./backup/',done);
    });

    after(function (done) {
        require('../helpers/clear-backup-dir')('./backup/',done);
    });

    it('should create the backup directories', function (done) {
        should.exists(BackupDirectory.baseDir);
        should.exists(BackupDirectory.attachmentsDir);
        should.exists(BackupDirectory.eventsFile);
        BackupDirectory.createDirs(function(err) {
            should.not.exists(err);
            should.equal(fs.existsSync(BackupDirectory.baseDir),true);
            should.equal(fs.existsSync(BackupDirectory.attachmentsDir),true);
            done();
        });
    });
});