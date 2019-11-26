/*global describe, it, before, after */

const Directory = require('../../src/methods/backup-directory');
const credentials = require('../helpers/testuser').credentials;
const fs = require('fs');
const should = require('should');

describe('backup-directory', function () {

    let BackupDirectory = null;

    before(function (done) {
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        BackupDirectory.deleteDirs(done);
    });

    after(function (done) {
        BackupDirectory.deleteDirs(done);
    });

    it('should create and delete the backup directories', function (done) {
        should.exists(BackupDirectory.baseDir);
        should.exists(BackupDirectory.attachmentsDir);
        should.exists(BackupDirectory.eventsFile);
        BackupDirectory.createDirs(function(err) {
            should.not.exists(err);
            fs.existsSync(BackupDirectory.baseDir).should.equal(true);
            fs.existsSync(BackupDirectory.attachmentsDir).should.equal(true);
            BackupDirectory.deleteDirs(function(err) {
                should.not.exists(err);
                fs.existsSync(BackupDirectory.baseDir).should.equal(false);
                fs.existsSync(BackupDirectory.attachmentsDir).should.equal(false);
                done();
            });
        });
    });

});