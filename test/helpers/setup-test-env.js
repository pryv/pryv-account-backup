var pryv = require('pryv'),
    testUser = require('../helpers/testuser'),
    async = require('async'),
    fs = require('fs'),
    rmdir = require('rmdir');

module.exports = function(dir, callback) {
    var connection = new pryv.Connection(testUser.credentials);

    async.series([
        function clearBackupDir(done) {
            if(fs.existsSync(dir)) {
                rmdir(dir, function (err) {
                    done(err);
                });
            } else {
                done();
            }
        },
        function clearPryv(done) {
            connection.batchCall([
                {
                    method: 'streams.delete',
                    params: {
                        id: testUser.stream
                    }
                },
                {
                    method: 'streams.delete',
                    params: {
                        id: testUser.stream,
                        mergeEventsWithParent: false
                    }
                }
            ], function (err) {
                done(err);
            });
        },
        function feedPryv(done) {
            connection.batchCall([
                {
                    method: 'streams.create',
                    params: {
                        id: testUser.stream,
                        name: testUser.stream
                    }
                }
            ], function (err) {
                done(err);
            });
        },
        function createBackupDir(done) {
            fs.mkdirSync(dir);
            done();
        }
    ], function (err) {
        callback(err);
    });
};