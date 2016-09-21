var pryv = require('pryv');

var testUser = require('../helpers/testuser');
var connection = new pryv.Connection(testUser.credentials);

connection.batchCall([
    {
        method: 'streams.create',
        params: {
            id: testUser.stream,
            name: testUser.stream
        }
    }
], function (err, res) {
    if (err) {
        return console.error(err);
    }
    console.log(res);
});