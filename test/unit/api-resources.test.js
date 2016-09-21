/*global describe, it, before, after */

var api = require('../../src/methods/api-resources'),
    pryv = require('pryv'),
    credentials = require('../helpers/testuser').credentials,
    fs = require('fs'),
    should = require('should');

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
        params.folder = backupDir;
        params.connection = connection;
        require('../helpers/setup-test-env')(backupDir,done);
    });

    it('should retrieve the requested Pryv resource and save it to JSON', function (done) {

        var eventsRequest = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000;
        var streamsRequest = 'streams';
        if (params.includeTrashed) {
            eventsRequest += '&state=all';
            streamsRequest += '?state=all';
        }

        params.resource = 'streams';

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            should.equal(fs.existsSync(backupDir+params.resource+'.json'),true);
            done();
        });
    });

    it('should retrieve the requested augmented Pryv resource and save it to JSON', function (done) {

        params.resource = 'events?fromTime=-2350373077&toTime=' + new Date() / 1000 + '&state=all';

        api.toJSONFile(params, function(err) {
            should.not.exist(err);
            should.equal(fs.existsSync(backupDir+'events.json'),true);
            done();
        });
    });

    it('should not retrieve and save to JSON invalid requested Pryv resource', function (done) {

        params.resource = 'notvalid';

        api.toJSONFile(params, function(err) {
            should.exist(err);
            should.equal(fs.existsSync(backupDir+params.resource+'.json'),false);
            done();
        });
    });
});