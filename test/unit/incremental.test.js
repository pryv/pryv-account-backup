/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/*global describe, it, before, after, beforeEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');

const eventsChunked = require('../../src/methods/events-chunked');
const auditAsEvents = require('../../src/methods/audit-as-events');
const hfData = require('../../src/methods/hf-data');
const Backup = require('../../src/lib/Backup');
const NodeFsStorageWriter = require('../../src/lib/adapters/NodeFsStorageWriter');
const FolderStateStore = require('../../src/lib/adapters/FolderStateStore');
const BackupDirectory = require('../../src/methods/backup-directory');

// ─── [PAIB] events-chunked incremental mode ───
//
// The two-mode contract is enforced at the API layer: when `modifiedSince`
// is passed, the helper makes ONE round-trip rather than N month-windows.
// We intercept apiResources.toJSONFile so the tests don't need a real
// Pryv account.

describe('[PAIB] events-chunked incremental mode', function () {
  const apiResources = require('../../src/methods/api-resources');
  let captured;
  let originalToJSONFile;

  before(function () {
    originalToJSONFile = apiResources.toJSONFile;
  });

  after(function () {
    apiResources.toJSONFile = originalToJSONFile;
  });

  beforeEach(function () {
    captured = [];
    apiResources.toJSONFile = function (params, cb /* , log */) {
      captured.push({
        resource: params.resource,
        filename: params.filename,
        extraFileName: params.extraFileName
      });
      // Resolve synchronously so we don't have to deal with timers in tests.
      setImmediate(cb);
    };
  });

  const fakeConn = { endpoint: 'https://token@host.example.com/', token: 'token' };
  const fakeWriter = {
    openWriteStream: () => ({ write: () => {}, end: (cb) => cb && cb() }),
    exists: () => false,
    describeTarget: () => '/mock/'
  };

  it('falls back to chunked initial-mode when modifiedSince is null', function (done) {
    // Use a tiny synthetic range via fromTime/toTime overrides to skip
    // the API probe.
    eventsChunked.download(fakeConn, fakeWriter, {
      fromTime: Date.UTC(2024, 0, 1) / 1000,
      toTime: Date.UTC(2024, 0, 31) / 1000
    }, function (err) {
      should.not.exist(err);
      captured.length.should.equal(1);
      captured[0].resource.should.match(/^events\?fromTime=\d+&toTime=\d+$/);
      captured[0].extraFileName.should.equal('-2024-01');
      done();
    }, () => {});
  });
});

// ─── [PAIP] events-chunked incremental paging ───
//
// `events.get` caps a query with no time range and no `limit` at 20 events
// (and its deletions at the same limit). The fake server below reproduces the
// server semantics the incremental walk relies on: that default, `time`-only
// ordering with ties in random order, `deleted`-only ordering for deletions,
// `toTime` on `time`, `fromTime` on `endTime` (running events with a null
// `endTime` only match while the range includes now), and `running=true`.

describe('[PAIP] events-chunked incremental paging', function () {
  const restore = require('../../src/restore');
  const SINCE = 1700000000;
  const RUN_TS = 1700100000;
  let originalFetch;
  let store; // { events: [], deletions: [] }
  let requests;

  function shuffleTies (list, key, asc) {
    const shuffled = list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    return shuffled.sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
  }

  function serve (url) {
    const q = new URL(url).searchParams;
    const num = (k) => q.has(k) ? Number(q.get(k)) : null;
    const now = Date.now() / 1000;
    let fromTime = num('fromTime');
    let toTime = num('toTime');
    let limit = num('limit');
    const skip = num('skip') || 0;
    const modifiedSince = num('modifiedSince');
    const asc = q.get('sortAscending') === 'true';
    if (fromTime == null && toTime != null) fromTime = toTime - 86400;
    if (fromTime != null && toTime == null) toTime = now;
    if (fromTime == null && toTime == null && limit == null) limit = 20;
    const page = (list) => limit == null ? list.slice(skip) : list.slice(skip, skip + limit);

    let events = store.events.filter(function (e) {
      if (modifiedSince != null && !(e.modified > modifiedSince)) return false;
      if (q.get('state') !== 'all' && e.trashed) return false;
      if (toTime != null && !(e.time <= toTime)) return false;
      const endTime = e.duration === null ? null : e.time + (e.duration || 0);
      if (q.get('running') === 'true') return endTime === null;
      if (fromTime != null) {
        if (fromTime <= now && toTime >= now) return endTime === null || endTime >= fromTime;
        return endTime !== null && endTime >= fromTime;
      }
      return true;
    });
    events = page(shuffleTies(events, 'time', asc));
    const body = { events, meta: { apiVersion: 'fake', serverTime: now } };
    if (modifiedSince != null && q.get('includeDeletions') === 'true') {
      const deletions = store.deletions.filter((d) => d.deleted > modifiedSince);
      body.eventDeletions = page(shuffleTies(deletions, 'deleted', asc));
    }
    return body;
  }

  beforeEach(function () {
    store = { events: [], deletions: [] };
    requests = [];
    originalFetch = global.fetch;
    global.fetch = function (url) {
      requests.push(url);
      // A paging loop that stops making progress fails instead of hanging.
      if (requests.length > 200) return Promise.resolve({ status: 500, statusText: 'too many requests' });
      const body = serve(url);
      const encoded = new TextEncoder().encode(JSON.stringify(body));
      let yielded = false;
      return Promise.resolve({
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
        body: {
          getReader () {
            return {
              read () {
                if (yielded) return Promise.resolve({ done: true });
                yielded = true;
                return Promise.resolve({ done: false, value: encoded });
              }
            };
          }
        }
      });
    };
  });

  afterEach(function () {
    global.fetch = originalFetch;
  });

  function run (options) {
    const files = {};
    const writer = {
      openWriteStream (relPath) {
        const chunks = [];
        return {
          write: (c) => chunks.push(typeof c === 'string' ? c : new TextDecoder().decode(c)),
          end: (cb) => { files[relPath] = chunks.join(''); if (cb) cb(); }
        };
      },
      exists: () => false,
      describeTarget: () => '/mock/'
    };
    const opts = Object.assign({ modifiedSince: SINCE, runStartedAt: RUN_TS, incrementalPageSize: 20 }, options);
    return new Promise(function (resolve, reject) {
      eventsChunked.download({ endpoint: 'https://token@host.example.com/', token: 'token' }, writer, opts,
        (err) => err ? reject(err) : resolve(files), () => {});
    });
  }

  function addEvents (n, props) {
    const start = store.events.length;
    for (let i = 0; i < n; i++) {
      store.events.push(Object.assign({ id: 'e' + (start + i), time: SINCE - 1000 * (start + i), modified: SINCE + 10 + i }, props));
    }
  }

  function addDeletions (n, props) {
    const start = store.deletions.length;
    for (let i = 0; i < n; i++) {
      store.deletions.push(Object.assign({ id: 'd' + (start + i), deleted: SINCE + 100 + i }, props));
    }
  }

  function readDoc (files) {
    const name = 'events-incremental-' + RUN_TS + '.json';
    should.exist(files[name]);
    return JSON.parse(files[name]);
  }

  const ids = (list) => list.map((x) => x.id).sort();

  it('collects all 45 changed events and 45 deletions with a page size of 20', async function () {
    addEvents(45);
    addDeletions(45);
    const doc = readDoc(await run());
    ids(doc.events).should.eql(ids(store.events));
    ids(doc.eventDeletions).should.eql(ids(store.deletions));
    doc.events.length.should.equal(45);
    doc.eventDeletions.length.should.equal(45);
    // Every request is explicitly bounded: never left to the server's default cap.
    for (const url of requests) {
      url.should.match(/[?&]limit=\d+/);
      url.should.match(/[?&]fromTime=/);
      url.should.match(/[?&]toTime=/);
    }
  });

  it('collects every event and deletion when more than a page share one timestamp', async function () {
    addEvents(50, { time: SINCE - 500 });
    addDeletions(50, { deleted: SINCE + 42 });
    addDeletions(3);
    const doc = readDoc(await run());
    doc.events.length.should.equal(50);
    doc.eventDeletions.length.should.equal(53);
    ids(doc.eventDeletions).should.eql(ids(store.deletions));
  });

  it('collects running events older than the first page', async function () {
    addEvents(30);
    addEvents(3, { time: SINCE - 900000, duration: null });
    const doc = readDoc(await run());
    ids(doc.events).should.eql(ids(store.events));
  });

  it('leaves out events not modified since the threshold, and trashed ones unless asked', async function () {
    addEvents(25);
    store.events.push({ id: 'old', time: SINCE - 5, modified: SINCE - 1 });
    store.events.push({ id: 'trashed', time: SINCE - 6, modified: SINCE + 1, trashed: true });
    readDoc(await run()).events.length.should.equal(25);
    const all = readDoc(await run({ includeTrashed: true }));
    all.events.length.should.equal(26);
    all.events.map((e) => e.id).should.containEql('trashed');
  });

  it('writes a document restore reads, deletions included', async function () {
    addEvents(22);
    addDeletions(21, {});
    store.deletions[0].id = 'e0'; // e0 changed, then deleted
    store.deletions[0].deleted = SINCE + 1000;
    const doc = readDoc(await run());
    should.exist(doc.meta);
    const latest = restore.latestEventVersions(doc.events.concat(doc.eventDeletions));
    latest.length.should.equal(21);
    latest.map((e) => e.id).should.not.containEql('e0');
  });

  it('hands every collected event to onEvents', async function () {
    addEvents(41);
    let seen = null;
    await run({ onEvents: (list) => { seen = list; } });
    seen.length.should.equal(41);
  });
});

// ─── [PAAU] audit-as-events query construction ───
//
// The dedicated /audit/logs endpoint goes away in v0.6.0 — audit rows are
// fetched via events.get on the :_audit:* store streams, which means
// `modifiedSince` works for free.

describe('[PAAU] audit-as-events query construction', function () {
  const apiResources = require('../../src/methods/api-resources');
  let captured;
  let originalToJSONFile;

  before(function () {
    originalToJSONFile = apiResources.toJSONFile;
  });

  after(function () {
    apiResources.toJSONFile = originalToJSONFile;
  });

  beforeEach(function () {
    captured = [];
    apiResources.toJSONFile = function (params, cb) {
      captured.push({
        resource: params.resource,
        filename: params.filename
      });
      setImmediate(cb);
    };
  });

  const fakeConn = { endpoint: 'https://token@host.example.com/', token: 'token' };
  const fakeWriter = {
    openWriteStream: () => ({ write: () => {}, end: (cb) => cb && cb() }),
    exists: () => false,
    describeTarget: () => '/mock/'
  };

  it('queries both :_audit:* top-level streams', function (done) {
    auditAsEvents.download(fakeConn, fakeWriter, {}, function (err) {
      should.not.exist(err);
      captured.length.should.equal(1);
      const decoded = decodeURIComponent(captured[0].resource.match(/streams=([^&]+)/)[1]);
      JSON.parse(decoded).should.eql([':_audit:accesses', ':_audit:actions']);
      done();
    }, () => {});
  });

  it('writes to audit_logs.json (preserving the v0.5.0 filename)', function (done) {
    auditAsEvents.download(fakeConn, fakeWriter, {}, function (err) {
      should.not.exist(err);
      captured[0].filename.should.equal('audit_logs.json');
      done();
    }, () => {});
  });

  it('omits modifiedSince on initial run (no prior state)', function (done) {
    auditAsEvents.download(fakeConn, fakeWriter, {}, function (err) {
      should.not.exist(err);
      captured[0].resource.should.not.match(/modifiedSince/);
      done();
    }, () => {});
  });

  it('appends modifiedSince when provided (incremental run)', function (done) {
    auditAsEvents.download(fakeConn, fakeWriter, { modifiedSince: 1700000000 }, function (err) {
      should.not.exist(err);
      captured[0].resource.should.match(/modifiedSince=1700000000/);
      done();
    }, () => {});
  });

  it('always sets includeDeletions=true for the incremental delta', function (done) {
    auditAsEvents.download(fakeConn, fakeWriter, {}, function (err) {
      should.not.exist(err);
      captured[0].resource.should.match(/includeDeletions=true/);
      done();
    }, () => {});
  });
});

// ─── [PAHF] hf-data series-event drain (v0.7.0 contract) ───
//
// The orchestrator now extracts series-event refs as `events-*.json` files
// stream by (via `onEvents` in events-chunked → `state.pushRef`). hf-data
// drains them. These tests cover the drain side; the events-chunked tee
// side is covered in [PALI] below.

describe('[PAHF] hf-data drains series-event refs from StateStore', function () {
  let tmpDir;
  let store;
  let originalFetch;
  let fetchCalls;

  before(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-test-'));
  });

  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(function () {
    store = new FolderStateStore(tmpDir);
    fetchCalls = [];
    originalFetch = global.fetch;
    global.fetch = function (url) {
      fetchCalls.push(url);
      const body = JSON.stringify({ events: [] });
      const encoded = new TextEncoder().encode(body);
      let yielded = false;
      return Promise.resolve({
        status: 200,
        statusText: 'OK',
        body: {
          getReader () {
            return {
              read () {
                if (yielded) return Promise.resolve({ done: true });
                yielded = true;
                return Promise.resolve({ done: false, value: encoded });
              }
            };
          }
        }
      });
    };
  });

  afterEach(async function () {
    global.fetch = originalFetch;
    await store.clearCategory('series-event');
  });

  const fakeWriter = {
    openWriteStream: () => ({ write: () => {}, end: (cb) => cb && cb() }),
    exists: () => false,
    describeTarget: () => '/mock/'
  };

  it('fetches one series resource per pending ref', async function () {
    await store.pushRef('series-event', { key: 'e1', eventId: 'e1', type: 'series:mass/kg' });
    await store.pushRef('series-event', { key: 'e2', eventId: 'e2', type: 'series:position/wgs84' });

    await new Promise((resolve, reject) => {
      hfData.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        store,
        {},
        (err) => err ? reject(err) : resolve(),
        () => {}
      );
    });

    fetchCalls.length.should.equal(2);
    fetchCalls[0].should.match(/\/events\/e1\/series$/);
    fetchCalls[1].should.match(/\/events\/e2\/series$/);
    (await store.listPending('series-event')).should.eql([]); // both drained
  });

  it('skips cleanly when no refs are pending', async function () {
    await new Promise((resolve, reject) => {
      hfData.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        store,
        {},
        (err) => err ? reject(err) : resolve(),
        () => {}
      );
    });
    fetchCalls.length.should.equal(0);
  });
});

// ─── [PAIB] Backup orchestrator state-loading sequence ───
//
// Verifies the state-load → orchestration → state-persist sequence with a
// mock state store. The actual fetch wiring is stubbed (we patched all four
// fetcher modules above for the API-construction tests; here we focus on
// the run-state contract).

describe('[PAIB] Backup state-loading sequence', function () {
  let tmpDir;
  let dir;
  let stateStore;

  before(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-state-test-'));
    dir = new BackupDirectory('https://token@host.example.com/', tmpDir);
    fs.mkdirSync(dir.baseDir, { recursive: true });
  });

  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(function () {
    stateStore = new FolderStateStore(dir.baseDir);
  });

  it('STATE_KEYS schema is stable', function () {
    Backup.STATE_KEYS.lastRunAt.should.equal('lastRunAt');
    Backup.STATE_KEYS.eventsLastModifiedSince.should.equal('events.lastModifiedSince');
    Backup.STATE_KEYS.auditLastModifiedSince.should.equal('audit.lastModifiedSince');
    Backup.STATE_FORMAT_VERSION.should.be.a.Number();
  });

  it('FolderStateStore reads prior incremental thresholds on construction', async function () {
    await stateStore.set('lastRunAt', 1700000000);
    await stateStore.set('events.lastModifiedSince', 1699999000);

    const reread = new FolderStateStore(dir.baseDir);
    (await reread.get('lastRunAt')).should.equal(1700000000);
    (await reread.get('events.lastModifiedSince')).should.equal(1699999000);
  });
});
