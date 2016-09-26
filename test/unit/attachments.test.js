/*global describe, it, before, after */

var attachments = require('../../src/methods/attachments'),
    credentials = require('../helpers/testuser').credentials,
    api = require('../../src/methods/api-resources'),
    Directory = require('../../src/methods/backup-directory'),
    fs = require('fs'),
    pryv = require('pryv'),
    should = require('should'),
    async = require('async');

describe('attachments', function () {

    var connection = null,
        BackupDirectory = null;

    before(function (done) {
        connection = new pryv.Connection(credentials);
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        async.series([
                BackupDirectory.deleteDirs,
                function create(stepDone) {
                    BackupDirectory.createDirs(stepDone);
                },
                function createEventsFile(stepDone) {
                    var params = {
                        folder: BackupDirectory.baseDir,
                        resource: 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all',
                        connection: connection
                    };
                    api.toJSONFile(params, stepDone);
                }
            ],
            function (err) {
                if (err) {
                    return done(err);
                }
                done();
            });
    });

    after(function (done) {
       BackupDirectory.deleteDirs(done);
    });

    it('should download the attachments', function (done) {
        attachments.download(connection,BackupDirectory,function(err) {

            should.not.exists(err);

            var events = JSON.parse(fs.readFileSync(BackupDirectory.eventsFile, 'utf8'));
            events.events.forEach(function (event) {
                if (event.attachments) {
                    event.attachments.forEach(function (att) {
                        var attFile = BackupDirectory.attachmentsDir + event.id + '_' + att.fileName;
                        fs.existsSync(attFile).should.equal(true);
                    });
                }
            });

            done();
        });
    });

});