/*global describe, it, before, after */

var Directory = require('../../src/methods/backup-directory'),
    credentials = require('../helpers/testuser').credentials,
    fs = require('fs'),
    should = require('should');

describe('backup-directory', function () {

    var BackupDirectory = null;

    before(function (done) {
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        BackupDirectory.deleteDirs(done);
    });

    after(function (done) {
        BackupDirectory.deleteDirs(done);
    });

    it('should create the backup directories', function (done) {
        should.exists(BackupDirectory.baseDir);
        should.exists(BackupDirectory.attachmentsDir);
        should.exists(BackupDirectory.eventsFile);
        BackupDirectory.createDirs(function(err) {
            should.not.exists(err);
            fs.existsSync(BackupDirectory.baseDir).should.equal(true);
            fs.existsSync(BackupDirectory.attachmentsDir).should.equal(true);
            done();
        });
    });
});