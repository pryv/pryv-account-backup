var fs = require('fs'),
    rmdir = require('rmdir');

module.exports = function(dir, callback) {
    if(fs.existsSync(dir)) {
        rmdir(dir, function (err) {
            callback(err);
        });
    } else {
        callback();
    }
};