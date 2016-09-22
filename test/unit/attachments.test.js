/*global describe, it, before, after */

var attachments = require('../../src/methods/attachments'),
    credentials = require('../helpers/testuser').credentials,
    Directory = require('../../src/methods/backup-directory'),
    fs = require('fs'),
    pryv = require('pryv'),
    should = require('should');

describe('attachments', function () {

    var connection = null,
        BackupDirectory = null,
        baseDir = './backup/',
        backupDir = baseDir + credentials.username + '.' + credentials.domain + '/',
        testEvent = {
            "events": [
                {
                    "attachments": [
                        {
                            "id": "citbmzlj9cjhc35yq7bscd7u5",
                            "fileName": "inception.jpg",
                            "type": "image/jpeg",
                            "size": 27810,
                            "readToken": "cit9zsixicj2235yqs3fgmifr-4DdVRubwrO4DrpEEaMhV9ZC6ETQ"
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
                    "id": "citbmzlj8cjhb35yqxrbfhj5j"
                }
            ],
            "meta": {
                "apiVersion": "1.1.2",
                "serverTime": 1474548745.049
            }
        };

    before(function (done) {
        connection = new pryv.Connection(credentials);
        require('../helpers/clear-backup-dir')(baseDir,function() {
            BackupDirectory = new Directory(credentials.username,credentials.domain);
            BackupDirectory.createDirs(fs.writeFile(BackupDirectory.eventsFile, JSON.stringify(testEvent, null, 4), done));
        });
    });

    after(function (done) {
        require('../helpers/clear-backup-dir')(baseDir,done);
    });

    it('should download the attachments', function (done) {

        attachments.download(connection,BackupDirectory,function() {

        });
    });
});