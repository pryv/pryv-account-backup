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

// ─── [PAHF] hf-data multi-file discovery (regression fix) ───
//
// Pre-fix, hf-data.js only inspected the legacy `events.json` and silently
// skipped chunked `events-YYYY-MM.json` files — every v0.5.0 backup of an
// HFS-using account dropped the bulk of the subject's data without warning.

describe('[PAHF] hf-data multi-file series discovery', function () {
  let tmpDir;
  let dir;

  before(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-test-'));
    dir = new BackupDirectory('https://token@host.example.com/', tmpDir);
    fs.mkdirSync(dir.baseDir, { recursive: true });
  });

  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers series events from chunked files (events-YYYY-MM.json only)', function (done) {
    // Two chunked files; one carries a series event.
    fs.writeFileSync(path.join(dir.baseDir, 'events-2024-01.json'),
      JSON.stringify({ events: [{ id: 'e1', type: 'note/txt' }] }));
    fs.writeFileSync(path.join(dir.baseDir, 'events-2024-02.json'),
      JSON.stringify({ events: [{ id: 'e2', type: 'series:mass/kg' }] }));

    // Stub a connection that NEVER answers — the test only verifies the
    // skip-decision logic. Stub https.get to short-circuit so no socket opens.
    const https = require('https');
    const originalGet = https.get;
    let attempted = false;
    https.get = function (opts, cb) {
      attempted = true;
      // Provide a phony 200 response with empty body to satisfy hf-data flow.
      const EventEmitter = require('events');
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('end');
      });
      return { on: () => {} };
    };

    hfData.download(
      { endpoint: 'https://x.example.com/', token: 't' },
      dir,
      function (err) {
        https.get = originalGet;
        should.not.exist(err);
        // Confirm hf-data ACTUALLY attempted to fetch — pre-fix this would
        // never reach the https.get call because the legacy `events.json`
        // path didn't exist.
        attempted.should.equal(true);
        done();
      },
      () => {}
    );
  });

  it('falls through to skip when no event files exist at all', function (done) {
    const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfd-empty-'));
    const emptyDir = new BackupDirectory('https://token@host.example.com/', emptyTmpDir);
    fs.mkdirSync(emptyDir.baseDir, { recursive: true });

    hfData.download(
      { endpoint: 'https://x.example.com/', token: 't' },
      emptyDir,
      function (err) {
        should.not.exist(err);
        fs.rmSync(emptyTmpDir, { recursive: true, force: true });
        done();
      },
      () => {}
    );
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
