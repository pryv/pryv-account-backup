/*global describe, it, before, after */

const attachments = require('../../src/methods/attachments');
const testuser = require('../helpers/testuser');
const credentials = testuser.credentials
const api = require('../../src/methods/api-resources');
const Directory = require('../../src/methods/backup-directory');
const fs = require('fs');
const should = require('should');
const async = require('async');

describe('attachments', function () {

    let connection = null;
    let BackupDirectory = null;

    before(function (done) {
        const domain = testuser.extractDomain(credentials.serviceInfoUrl);
        connection = {'auth': credentials.auth, 'username': credentials.username, 'settings': {'port': 443, 'domain': domain}};
        BackupDirectory = new Directory(credentials.username,domain);
        async.series([
                BackupDirectory.deleteDirs,
                function create(stepDone) {
                    BackupDirectory.createDirs(stepDone);
                },
                function createEventsFile(stepDone) {
                    const params = {
                        folder: BackupDirectory.baseDir,
                        resource: 'events',
                        connection: connection,
                        apiUrl: credentials.username + '.' + domain
                    };
                    api.toJSONFile(params, stepDone);
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