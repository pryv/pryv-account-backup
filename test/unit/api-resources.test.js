/*global describe, it, before, after */

const api = require('../../src/methods/api-resources');
const pryv = require('pryv');
const credentials = require('../helpers/testuser').credentials;
const Directory = require('../../src/methods/backup-directory');
const fs = require('fs');
const async = require('async');
const should = require('should');

describe('api-resources', function () {

    let connection = null;
    let BackupDirectory = null;
    const params = {
            folder: null,
            resource: null,
            connection: null
        };
    let apiUrl;

    before(function (done) {
        apiUrl = credentials.username + '.' + credentials.domain;
        connection = new pryv.Connection(credentials);
        BackupDirectory = new Directory(credentials.username,credentials.domain);
        params.folder = BackupDirectory.baseDir;
        params.connection = connection;

        async.series([
            BackupDirectory.deleteDirs,
            function create(stepDone) {
                BackupDirectory.createDirs(stepDone);
            }], done);
    });

    after(function (done) {
        BackupDirectory.deleteDirs(done);
    });

    it('should retrieve the requested Pryv resource and save it to JSON', function (done) {

        params.resource = 'streams';

        api.toJSONFile(apiUrl, params, function(err) {
            should.not.exist(err);
            fs.existsSync(params.folder+'/'+params.resource+'.json').should.equal(true);
            done();
        });
    });

    it('should retrieve the requested augmented Pryv resource and save it to JSON', function (done) {

        params.resource = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';

        api.toJSONFile(apiUrl, params, function(err) {
            should.not.exist(err);
            fs.existsSync(params.folder+'/'+'events.json').should.equal(true);
            done();
        });
    });

    it('should not retrieve and save to JSON invalid requested Pryv resource', function (done) {

        params.resource = 'notvalid';

        api.toJSONFile(apiUrl, params, function(err, res) {
            should.exist(err);
            fs.existsSync(params.folder+'/'+params.resource+'.json').should.equal(false);
            done();
        });
    });
});