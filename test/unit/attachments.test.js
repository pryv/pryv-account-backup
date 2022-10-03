/*global describe, it, before, after */

const attachments = require('../../src/methods/attachments');
const testuser = require('../helpers/testuser');
const credentials = testuser.credentials
const api = require('../../src/methods/api-resources');
const Directory = require('../../src/methods/backup-directory');
const fs = require('fs');
const should = require('should');
const async = require('async');
const Pryv = require('pryv');

describe('attachments', function () {

    let connection = null;
    let BackupDirectory = null;

    before(function (done) {
        const service = new Pryv.Service(credentials.serviceInfoUrl);
        async.series([
                function login(stepDone) {
                  service.login(credentials.username, credentials.password, 'bkp-test').then((conn, err) => { 
                    if (err) return stepDone(err);
                    connection = conn;
                    BackupDirectory = new Directory(conn.endpoint);
                    stepDone();
                  });
                },
                function deleteDirectories(stepDone) {
                  BackupDirectory.deleteDirs(stepDone);
                },
                function create(stepDone) {
                  BackupDirectory.createDirs(stepDone);
                },
                function createEventsFile(stepDone) {
                    const params = {
                        folder: BackupDirectory.baseDir,
                        resource: 'events',
                        connection: connection
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