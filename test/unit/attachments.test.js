/*global describe, it, before, after */

var attachments = require('../../src/methods/attachments'),
    credentials = require('../helpers/testuser').credentials,
    Directory = require('../../src/methods/backup-directory'),
    fs = require('fs'),
    pryv = require('pryv'),
    should = require('should'),
    async = require('async');

describe('attachments', function () {

    var connection = null,
        BackupDirectory = null,
        testEvent = {
            "events": [
                {
                    "attachments": [
                        {
                            "id": "deede",
                            "fileName": "inception.jpg",
                            "type": "image/jpeg",
                            "size": 27810,
                            "readToken": "dede-4DdVRubwrO4DrpEEaMhV9ZC6ETQ"
                        }
                    ],
                    "content": null,
                    "created": 1474385381.827,
                    "createdBy": "citbmxirkcjh635yqjl42xag3",
                    "description": "",
                    "modified": 1474385381.827,
                    "modifiedBy": "citbmxirkcjh635yqjl42xag3",
                    "streamId": "citbmz663cjh835yq04xgitpl",
                    "tags": [],
                    "time": 1467109533,
                    "type": "picture/attached",
                    "id": "bla"
                }
            ],
            "meta": {
                "apiVersion": "1.1.2",
                "serverTime": 1474548745.049
            }
        };

    before(function (done) {
        connection = new pryv.Connection(credentials);
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        async.series([
                BackupDirectory.deleteDirs,
                function create(stepDone) {
                    BackupDirectory.createDirs(stepDone);
                },
                function createEventsFile(stepDone) {
                    fs.writeFile(BackupDirectory.eventsFile, JSON.stringify(testEvent, null, 4), stepDone);
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

    it('should download and save the attachments', function (done) {
        attachments.download(connection,BackupDirectory,function(err) {
            should.not.exists(err);
            var attachment = BackupDirectory.attachmentsDir + testEvent.events[0].id + '_' + testEvent.events[0].attachments[0].fileName;
            fs.existsSync(attachment).should.equal(true);
            done();
        });
    });
});