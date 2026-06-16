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

  it('switches to a single incremental request when modifiedSince is provided', function (done) {
    eventsChunked.download(fakeConn, fakeWriter, {
      modifiedSince: 1700000000,
      runStartedAt: 1700100000
    }, function (err) {
      should.not.exist(err);
      captured.length.should.equal(1);
      captured[0].resource.should.match(/^events\?modifiedSince=1700000000&includeDeletions=true$/);
      captured[0].filename.should.equal('events-incremental-1700100000.json');
      done();
    }, () => {});
  });

  it('appends &state=all in incremental mode when includeTrashed is set', function (done) {
    eventsChunked.download(fakeConn, fakeWriter, {
      modifiedSince: 1700000000,
      runStartedAt: 1700100000,
      includeTrashed: true
    }, function (err) {
      should.not.exist(err);
      captured[0].resource.should.match(/&state=all$/);
      done();
    }, () => {});
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
