/*global describe, it, before, after */

const api = require('../../src/methods/api-resources');
const testuser = require('../helpers/testuser');
const credentials = testuser.credentials
const Directory = require('../../src/methods/backup-directory');
const fs = require('fs');
const async = require('async');
const should = require('should');
const Pryv = require('pryv');

describe('api-resources', function () {

    let connection = null;
    let BackupDirectory = null;
    const params = {
            folder: null,
            resource: null,
            connection: null
        };

    before(function (done) {
        const service = new Pryv.Service(credentials.serviceInfoUrl); 
        async.series([
          function login(stepDone) {
            service.login(credentials.username, credentials.password, 'bkp-test').then((conn, err) => { 
              if (err) return stepDone(err);
              params.connection = conn;
              BackupDirectory = new Directory(conn.endpoint);
              params.folder = BackupDirectory.baseDir;
              stepDone();
            });
          },
          function deleteDirectories(stepDone) {
            BackupDirectory.deleteDirs(stepDone);
          },
          function create(stepDone) {
              BackupDirectory.createDirs(stepDone);
          }], done);
    });

    after(function (done) {
        BackupDirectory.deleteDirs(done);
    });

    it('should retrieve the requested streams Pryv resource and save it to JSON', function (done) {

        params.resource = 'streams';

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            console.log(params.folder+params.resource+'.json');
            fs.existsSync(params.folder+params.resource+'.json').should.equal(true);
            done();
        });
    });

    it('should retrieve the requested augmented Pryv resource and save it to JSON', function (done) {

        params.resource = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            fs.existsSync(params.folder+'events.json').should.equal(true);
            done();
        });
    });

    it('should not retrieve and save to JSON invalid requested Pryv resource', function (done) {

        params.resource = 'notvalid';

        api.toJSONFile(params, function(err, res) {
            should.exist(err);
            fs.existsSync(params.folder+params.resource+'.json').should.equal(false);
            done();
        });
    });
});