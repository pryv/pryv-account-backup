var pryv = require('pryv');

var testUser = require('../helpers/testuser');
var connection = new pryv.Connection(testUser.credentials);

connection.batchCall([
    {
        method: 'streams.delete',
        params: {
            id: stream
        }
    },
    {
        method: 'streams.delete',
        params: {
            id: stream,
            mergeEventsWithParent: false
        }
    }
], function (err, res) {
    if (err) {
        return console.error(err);
    }
    console.log(res);
});