/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/* global describe, it */

const should = require('should');
const { EventEmitter } = require('events');
const pager = require('../../src/methods/events-pager');

// A writer whose stream records text and can refuse writes (backpressure) or fail.
function fakeWriter (behaviour) {
  behaviour = behaviour || {};
  const out = { text: '', ends: 0, stream: null };
  return {
    out,
    openWriteStream () {
      const s = new EventEmitter();
      let writes = 0;
      s.write = function (chunk) {
        writes++;
        out.text += new TextDecoder().decode(chunk);
        if (behaviour.failOnWrite === writes) {
          setTimeout(function () { s.emit('error', new Error('ENOSPC')); }, 5);
          return false;
        }
        if (behaviour.slowEvery && writes % behaviour.slowEvery === 0) {
          setTimeout(function () { s.emit('drain'); }, 5);
          return false;
        }
        return true;
      };
      s.end = function (cb) { out.ends++; if (cb) setTimeout(cb, 1); };
      out.stream = s;
      return s;
    }
  };
}

describe('[JSDC] events-pager openJSONDocument', function () {
  it('[JSDC1] writes an object with no array', async function () {
    const w = fakeWriter();
    const doc = pager.openJSONDocument(w, 'x.json');
    await doc.close({ meta: null });
    JSON.parse(w.out.text).should.eql({});
  });

  it('[JSDC2] writes empty and filled arrays with commas only between items, across pages', async function () {
    const w = fakeWriter();
    const doc = pager.openJSONDocument(w, 'x.json');
    await doc.array('events');
    await doc.items([]);
    await doc.array('eventDeletions');
    await doc.items([{ id: 'a' }]);
    await doc.items([]);
    await doc.items([{ id: 'b' }, { id: 'c' }]);
    await doc.close({ meta: { v: 1 } });
    JSON.parse(w.out.text).should.eql({ events: [], eventDeletions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], meta: { v: 1 } });
  });

  it('[JSDC3] closeIncomplete closes an open array, omits a null meta and flags the file; a second close is a no-op', async function () {
    const w = fakeWriter();
    const doc = pager.openJSONDocument(w, 'x.json');
    await doc.array('events');
    await doc.items([{ id: 'a' }]);
    await doc.closeIncomplete({ meta: null });
    await doc.close({ meta: { v: 2 } });
    JSON.parse(w.out.text).should.eql({ events: [{ id: 'a' }], incomplete: true });
    w.out.ends.should.equal(1);
  });

  it('[JSDC4] waits for drain when the stream asks for it', async function () {
    const w = fakeWriter({ slowEvery: 2 });
    const doc = pager.openJSONDocument(w, 'x.json');
    await doc.array('events');
    for (let i = 0; i < 6; i++) await doc.items([{ id: 'e' + i }]);
    await doc.close({});
    JSON.parse(w.out.text).events.length.should.equal(6);
  });

  it('[JSDC5] a stream error rejects the next write instead of hanging or crashing', async function () {
    const w = fakeWriter({ failOnWrite: 3 });
    const doc = pager.openJSONDocument(w, 'x.json');
    await doc.array('events');
    let err = null;
    try {
      await doc.items([{ id: 'a' }]);
      await doc.items([{ id: 'b' }]);
    } catch (e) { err = e; }
    should.exist(err);
    err.message.should.equal('ENOSPC');
    await doc.closeIncomplete({}, function () {}); // never throws
  });
});
