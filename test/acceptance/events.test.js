/*global describe, it, before, after */

var pryv = require('pryv');

describe('Events', function () {

  var connection = null,
    stream = 'testStream1';

  before(function (done) {

    connection = new pryv.Connection(require('../helpers/testuser').credentials);

    connection.batchCall([
      {
        method: 'streams.create',
        params: {
          id: stream,
          name: stream
        }
      },
      {
        method: 'events.create',
        params: {
          streamId: stream,
          type: 'note/txt',
          content: 'hi, i am a text event'
        }
      }
    ], function (err) {
      done(err);
    });

  });

  after(function (done) {

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
    ], function (err) {
      done(err);
    })
  });

  it('should backup events in the right folder', function (done) {
    console.log('todo');
    done();
  })

});