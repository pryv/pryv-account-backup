/*global describe, it, before, after */

var api = require('../../src/methods/api-resources'),
    pryv = require('pryv'),
    credentials = require('../helpers/testuser').credentials,
    fs = require('fs'),
    should = require('should'),
    rmdir = require('rmdir');

describe('api-resources', function () {

    var connection = null,
        backupDir = './' + credentials.username + '.' + credentials.domain + '/',
        params = {
            folder: null,
            resource: null,
            connection: null
        };

    before(function (done) {
        connection = new pryv.Connection(credentials);
        fs.mkdirSync(backupDir);
        params.folder = backupDir;
        params.connection = connection;
        done();
    });

    after(function (done) {
        if(fs.existsSync(backupDir)) {
            rmdir(backupDir, function (err) {
                done(err);
            });
        }
    });

    it('should retrieve the requested Pryv resource and save it to JSON', function (done) {

        params.resource = 'streams';

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            should.equal(fs.existsSync(backupDir+'streams.json'),true);
            done();
        });
    });
});