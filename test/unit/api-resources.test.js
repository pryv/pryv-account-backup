/*global describe, it, before, after */

const api = require('../../src/methods/api-resources');
const testuser = require('../helpers/testuser');
const credentials = testuser.credentials
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

    before(function (done) {
        const domain = testuser.extractDomain(credentials.serviceInfoUrl);
        connection = {'auth': credentials.auth, 'username': credentials.username, 'settings': {'port': 443, 'domain': domain}};
        BackupDirectory = new Directory(credentials.username,domain);
        params.folder = BackupDirectory.baseDir;
        params.connection = connection;
        params.apiUrl = credentials.username + '.' + domain;

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

        api.toJSONFile(params, function(err, res) {
            should.exist(err);
            fs.existsSync(params.folder+'/'+params.resource+'.json').should.equal(false);
            done();
        });
    });
});