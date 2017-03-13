/*global describe, it, before, after */

var api = require('../../src/methods/api-resources'),
    pryv = require('pryv'),
    credentials = require('../helpers/testuser').credentials,
    Directory = require('../../src/methods/backup-directory'),
    fs = require('fs'),
    async = require('async'),
    should = require('should');

describe('api-resources', function () {

    var connection = null,
        BackupDirectory = null,
        params = {
            folder: null,
            resource: null,
            connection: null
        };

    before(function (done) {
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

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            fs.existsSync(params.folder+'/'+params.resource+'.json').should.equal(true);
            done();
        });
    });

    it('should retrieve the requested augmented Pryv resource and save it to JSON', function (done) {

        params.resource = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            fs.existsSync(params.folder+'/'+'events.json').should.equal(true);
            done();
        });
    });

    it('should not retrieve and save to JSON invalid requested Pryv resource', function (done) {

        params.resource = 'notvalid';

        api.toJSONFile(params, function(err) {
            should.exist(err);
            fs.existsSync(params.folder+'/'+params.resource+'.json').should.equal(false);
            done();
        });
    });
});