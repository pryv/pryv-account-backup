/*global describe, it, before, after */

const attachments = require('../../src/methods/attachments');
const credentials = require('../helpers/testuser').credentials;
const api = require('../../src/methods/api-resources');
const Directory = require('../../src/methods/backup-directory');
const fs = require('fs');
const pryv = require('pryv');
const should = require('should');
const async = require('async');

describe('attachments', function () {

    let connection = null;
    let BackupDirectory = null;
    let apiUrl;

    before(function (done) {
        apiUrl = credentials.username + '.' + credentials.domain;
        connection = new pryv.Connection(credentials);
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        async.series([
                BackupDirectory.deleteDirs,
                function create(stepDone) {
                    BackupDirectory.createDirs(stepDone);
                },
                function createEventsFile(stepDone) {
                    const params = {
                        folder: BackupDirectory.baseDir,
                        resource: 'events',
                        connection: connection
                    };
                    api.toJSONFile(apiUrl, params, stepDone);
                }
            ], done);
    });

    after(function (done) {
        BackupDirectory.deleteDirs(done);
    });

    it('should download the attachments', function (done) {
        attachments.download(connection,BackupDirectory,function(err) {

            should.not.exists(err);

            const events = JSON.parse(fs.readFileSync(BackupDirectory.eventsFile, 'utf8'));
            events.events.forEach(function (event) {
                if (event.attachments) {
                    event.attachments.forEach(function (att) {
                        const attFile = BackupDirectory.attachmentsDir + '/' + event.id + '_' + att.fileName;
                        fs.existsSync(attFile).should.equal(true);
                    });
                }
            });

            done();
        });
    });

});