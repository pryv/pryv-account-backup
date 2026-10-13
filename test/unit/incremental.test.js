/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/* global describe, it, before, after, beforeEach, afterEach */

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

// ─── [PAIB] events-chunked initial mode ───
//
// Without `modifiedSince` the helper fetches month windows through
// apiResources.toJSONFile, intercepted here so the test needs no Pryv account.

describe('[PAIB] events-chunked initial mode', function () {
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

// ─── Fake `events.get` server ───
//
// `events.get` caps a query with no time range and no `limit` at 20 events
// (and its deletions at the same limit). The fake reproduces the server
// semantics the paged walks rely on: that default, `time`-only ordering with
// ties in random order, `deleted`-only ordering for deletions, `toTime` on
// `time`, `fromTime` on `endTime` (running events with a null `endTime` only
// match while the range includes now), `running=true`, `state`, `streams`
// (a stream id also matches its children), and `meta.serverTime`.
// `store.sqliteDeletions` switches deletions to the SQLite engine's
// behaviour: `deleted >= since`, newest first, limit / skip / order ignored.

const SINCE = 1700000000;
const RUN_TS = 1700100000;

function fakeServer () {
  // accessInfo: 'ok' | 'no-meta' (no meta.serverTime) | 'error' (HTTP 500)
  const server = { events: [], deletions: [], sqliteDeletions: false, serverTime: null, accessInfo: 'ok', requests: [] };

  function shuffleTies (list, key, asc) {
    const shuffled = list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    return shuffled.sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
  }

  function serve (url) {
    const u = new URL(url);
    const now = Date.now() / 1000;
    const meta = { apiVersion: 'fake', serverTime: server.serverTime != null ? server.serverTime : now };
    if (u.pathname.endsWith('/access-info') && server.accessInfo === 'no-meta') return { type: 'personal' };
    if (!u.pathname.endsWith('/events')) return { meta, accesses: [] };
    const q = u.searchParams;
    const num = (k) => q.has(k) ? Number(q.get(k)) : null;
    let fromTime = num('fromTime');
    let toTime = num('toTime');
    let limit = num('limit');
    const skip = num('skip') || 0;
    const modifiedSince = num('modifiedSince');
    const asc = q.get('sortAscending') === 'true';
    const streams = q.has('streams') ? JSON.parse(q.get('streams')) : null;
    if (fromTime == null && toTime != null) fromTime = toTime - 86400;
    if (fromTime != null && toTime == null) toTime = now;
    if (fromTime == null && toTime == null && limit == null) limit = 20;
    const page = (list) => limit == null ? list.slice(skip) : list.slice(skip, skip + limit);

    let events = server.events.filter(function (e) {
      const streamIds = e.streamIds || ['diary'];
      if (streams && !streamIds.some((s) => streams.some((p) => s === p || s.startsWith(p + ':')))) return false;
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
    const body = { events, meta };
    if (modifiedSince != null && q.get('includeDeletions') === 'true') {
      if (server.sqliteDeletions) {
        body.eventDeletions = shuffleTies(server.deletions.filter((d) => d.deleted >= modifiedSince), 'deleted', false);
      } else {
        body.eventDeletions = page(shuffleTies(server.deletions.filter((d) => d.deleted > modifiedSince), 'deleted', asc));
      }
    }
    return body;
  }

  server.fetch = function (url) {
    server.requests.push(url);
    // A paging loop that stops making progress fails instead of hanging.
    if (server.requests.length > 200) return Promise.resolve({ status: 500, statusText: 'too many requests' });
    if (url.endsWith('/access-info') && server.accessInfo === 'error') return Promise.resolve({ status: 500, statusText: 'boom' });
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

  server.addEvents = function (n, props) {
    const start = server.events.length;
    for (let i = 0; i < n; i++) {
      server.events.push(Object.assign({ id: 'e' + (start + i), time: SINCE - 1000 * (start + i), modified: SINCE + 10 + i }, props));
    }
  };

  server.addDeletions = function (n, props) {
    const start = server.deletions.length;
    for (let i = 0; i < n; i++) {
      server.deletions.push(Object.assign({ id: 'd' + (start + i), deleted: SINCE + 100 + i }, props));
    }
  };

  return server;
}

function memoryWriter () {
  const files = {};
  return {
    files,
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
}

const FAKE_CONN = { endpoint: 'https://token@host.example.com/', token: 'token' };
const ids = (list) => list.map((x) => x.id).sort();

// ─── [PAIP] events-chunked incremental paging ───

describe('[PAIP] events-chunked incremental paging', function () {
  const restore = require('../../src/restore');
  let originalFetch;
  let server;

  beforeEach(function () {
    server = fakeServer();
    originalFetch = global.fetch;
    global.fetch = server.fetch;
  });

  afterEach(function () {
    global.fetch = originalFetch;
  });

  function run (options) {
    const writer = memoryWriter();
    const opts = Object.assign({ modifiedSince: SINCE, runStartedAt: RUN_TS, incrementalPageSize: 20 }, options);
    return new Promise(function (resolve, reject) {
      eventsChunked.download(FAKE_CONN, writer, opts,
        (err) => err ? reject(err) : resolve(writer.files), () => {});
    });
  }

  function readDoc (files) {
    const name = 'events-incremental-' + RUN_TS + '.json';
    should.exist(files[name]);
    return JSON.parse(files[name]);
  }

  const deletionRequests = () => server.requests.filter((u) => u.includes('includeDeletions=true'));

  it('collects all 45 changed events and 45 deletions with a page size of 20', async function () {
    server.addEvents(45);
    server.addDeletions(45);
    const doc = readDoc(await run());
    ids(doc.events).should.eql(ids(server.events));
    ids(doc.eventDeletions).should.eql(ids(server.deletions));
    doc.events.length.should.equal(45);
    doc.eventDeletions.length.should.equal(45);
    // Every request is explicitly bounded: never left to the server's default cap.
    for (const url of server.requests) {
      url.should.match(/[?&]limit=\d+/);
      url.should.match(/[?&]fromTime=/);
      url.should.match(/[?&]toTime=/);
    }
  });

  it('collects every event and deletion when more than a page share one timestamp', async function () {
    server.addEvents(50, { time: SINCE - 500 });
    server.addDeletions(50, { deleted: SINCE + 42 });
    server.addDeletions(3);
    const doc = readDoc(await run());
    doc.events.length.should.equal(50);
    doc.eventDeletions.length.should.equal(53);
    ids(doc.eventDeletions).should.eql(ids(server.deletions));
  });

  it('collects running events older than the first page', async function () {
    server.addEvents(30);
    server.addEvents(3, { time: SINCE - 900000, duration: null });
    const doc = readDoc(await run());
    ids(doc.events).should.eql(ids(server.events));
  });

  it('collects all deletions in at most two requests when the engine ignores limit and order (SQLite)', async function () {
    server.sqliteDeletions = true;
    server.addDeletions(45);
    readDoc(await run()).eventDeletions.length.should.equal(45);
    deletionRequests().length.should.be.belowOrEqual(2);
  });

  it('stops after two deletion requests when the SQLite set is exactly one page', async function () {
    server.sqliteDeletions = true;
    server.addDeletions(20);
    readDoc(await run()).eventDeletions.length.should.equal(20);
    deletionRequests().length.should.be.belowOrEqual(2);
  });

  it('leaves out events not modified since the threshold, includes trashed ones without being asked', async function () {
    server.addEvents(25);
    server.events.push({ id: 'old', time: SINCE - 5, modified: SINCE - 1 });
    server.events.push({ id: 'trashed', time: SINCE - 6, modified: SINCE + 1, trashed: true });
    const doc = readDoc(await run());
    doc.events.length.should.equal(26);
    doc.events.map((e) => e.id).should.containEql('trashed');
    doc.events.map((e) => e.id).should.not.containEql('old');
  });

  it('writes a document restore reads, deletions included', async function () {
    server.addEvents(22);
    server.addDeletions(21, {});
    server.deletions[0].id = 'e0'; // e0 changed, then deleted
    server.deletions[0].deleted = SINCE + 1000;
    const doc = readDoc(await run());
    should.exist(doc.meta);
    const latest = restore.latestEventVersions(doc.events.concat(doc.eventDeletions));
    latest.length.should.equal(21);
    latest.map((e) => e.id).should.not.containEql('e0');
  });

  it('hands every collected event to onEvents, page by page', async function () {
    server.addEvents(41);
    const batches = [];
    await run({ onEvents: (list) => { batches.push(list); } });
    batches.length.should.be.above(1);
    ids([].concat(...batches)).should.eql(ids(server.events));
  });

  it('writes the file page by page instead of in one piece', async function () {
    server.addEvents(45);
    server.addDeletions(45);
    const writer = memoryWriter();
    const writes = [];
    const open = writer.openWriteStream;
    writer.openWriteStream = (relPath) => {
      const ws = open(relPath);
      const write = ws.write;
      ws.write = (c) => { writes.push(c); return write(c); };
      return ws;
    };
    await new Promise(function (resolve, reject) {
      eventsChunked.download(FAKE_CONN, writer,
        { modifiedSince: SINCE, runStartedAt: RUN_TS, incrementalPageSize: 20 },
        (err) => err ? reject(err) : resolve(), () => {});
    });
    writes.length.should.be.above(4);
    const doc = readDoc(writer.files);
    doc.events.length.should.equal(45);
    doc.eventDeletions.length.should.equal(45);
    should.not.exist(doc.incomplete);
  });

  it('closes the file as valid JSON marked incomplete when a request fails mid-run', async function () {
    server.addEvents(45);
    server.addDeletions(45);
    const fetchOk = server.fetch;
    let calls = 0;
    global.fetch = (url, opts) => (++calls === 2)
      ? Promise.resolve({ status: 500, statusText: 'boom', json: async () => ({}) })
      : fetchOk(url, opts);
    const writer = memoryWriter();
    const err = await new Promise(function (resolve) {
      eventsChunked.download(FAKE_CONN, writer,
        { modifiedSince: SINCE, runStartedAt: RUN_TS, incrementalPageSize: 20 },
        resolve, () => {});
    });
    should.exist(err);
    err.message.should.match(/HTTP 500/);
    const doc = readDoc(writer.files);
    doc.incomplete.should.equal(true);
    doc.events.length.should.equal(20);
    restore.latestEventVersions(doc.events).length.should.equal(20);
  });

  it('closes the file as valid JSON marked incomplete when the deletions walk fails', async function () {
    server.addEvents(25);
    server.addDeletions(5);
    const fetchOk = server.fetch;
    global.fetch = (url, opts) => url.includes('includeDeletions=true')
      ? Promise.resolve({ status: 503, statusText: 'busy', json: async () => ({}) })
      : fetchOk(url, opts);
    const writer = memoryWriter();
    const err = await new Promise(function (resolve) {
      eventsChunked.download(FAKE_CONN, writer,
        { modifiedSince: SINCE, runStartedAt: RUN_TS, incrementalPageSize: 20 },
        resolve, () => {});
    });
    should.exist(err);
    const doc = readDoc(writer.files);
    doc.incomplete.should.equal(true);
    doc.events.length.should.equal(25);
    doc.eventDeletions.should.eql([]);
  });
});

// ─── [PAAU] audit-as-events paging ───
//
// Audit rows are fetched via events.get on the :_audit:* store streams, so
// `modifiedSince` works for free, and the same default cap of 20 applies.

describe('[PAAU] audit-as-events paging', function () {
  let originalFetch;
  let server;

  beforeEach(function () {
    server = fakeServer();
    originalFetch = global.fetch;
    global.fetch = server.fetch;
    // Rows outside the audit streams, never part of the audit file.
    server.addEvents(10);
  });

  afterEach(function () {
    global.fetch = originalFetch;
  });

  function addAudit (n, props) {
    for (let i = 0; i < n; i++) {
      const stream = i % 2 ? ':_audit:actions:action-events.get' : ':_audit:accesses:access-a1';
      server.events.push(Object.assign({ id: 'a' + i, streamIds: [stream], time: SINCE - 700 * i, modified: SINCE + 5 + i }, props));
    }
  }

  function run (options) {
    const writer = memoryWriter();
    const opts = Object.assign({ pageSize: 20 }, options);
    return new Promise(function (resolve, reject) {
      auditAsEvents.download(FAKE_CONN, writer, opts,
        (err) => err ? reject(err) : resolve(writer.files), () => {});
    });
  }

  it('collects all 45 audit rows on an initial run with a page size of 20, into audit_logs.json', async function () {
    addAudit(45);
    const files = await run();
    Object.keys(files).should.eql(['audit_logs.json']);
    const doc = JSON.parse(files['audit_logs.json']);
    doc.events.length.should.equal(45);
    doc.events.every((e) => e.streamIds[0].startsWith(':_audit:')).should.equal(true);
    for (const url of server.requests) {
      JSON.parse(new URL(url).searchParams.get('streams')).should.eql([':_audit:accesses', ':_audit:actions']);
      url.should.match(/[?&]limit=\d+/);
      url.should.match(/[?&]toTime=/);
      url.should.not.match(/modifiedSince|includeDeletions/);
    }
  });

  it('collects every audit row changed since the threshold into a separate incremental file', async function () {
    addAudit(45);
    server.events.push({ id: 'a-old', streamIds: [':_audit:actions:action-x'], time: SINCE - 3, modified: SINCE - 1 });
    const files = await run({ modifiedSince: SINCE, runStartedAt: RUN_TS });
    Object.keys(files).should.eql(['audit_logs-incremental-' + RUN_TS + '.json']);
    const doc = JSON.parse(files['audit_logs-incremental-' + RUN_TS + '.json']);
    doc.events.length.should.equal(45);
    server.requests.every((u) => u.includes('modifiedSince=' + SINCE)).should.equal(true);
  });

  it('collects audit rows with a null endTime older than the first page', async function () {
    addAudit(30);
    for (let i = 0; i < 3; i++) {
      server.events.push({ id: 'a-null-' + i, streamIds: [':_audit:actions:action-x'], time: SINCE - 900000 - i, duration: null, modified: SINCE + 1 });
    }
    const doc = JSON.parse((await run())['audit_logs.json']);
    doc.events.length.should.equal(33);
    doc.events.map((e) => e.id).should.containEql('a-null-2');
  });

  it('appends state=all when includeTrashed is set', async function () {
    addAudit(3);
    await run({ includeTrashed: true });
    server.requests.every((u) => u.includes('state=all')).should.equal(true);
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

// ─── [PAST] incremental threshold from the server clock ───

describe('[PAST] Backup takes the incremental threshold from the server clock', function () {
  let tmpDir;
  let originalFetch;
  let server;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-servertime-test-'));
    server = fakeServer();
    originalFetch = global.fetch;
    global.fetch = server.fetch;
  });

  afterEach(function () {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runBackup (logs) {
    const dir = new BackupDirectory('https://token@host.example.com/', tmpDir);
    const backup = new Backup({
      connection: FAKE_CONN,
      writer: new NodeFsStorageWriter(dir),
      state: new FolderStateStore(dir.baseDir),
      options: { includeAttachments: false, includeHfData: false, includeWebhooks: false },
      log: (msg) => { if (logs) logs.push(String(msg)); }
    });
    return new Promise((resolve, reject) => backup.run((err) => err ? reject(err) : resolve(dir)));
  }

  it('persists meta.serverTime, not the local clock, and the next run asks from there', async function () {
    // Server clock a day behind the local one.
    server.serverTime = Math.floor(Date.now() / 1000) - 86400 + 0.75;
    const expected = Math.floor(server.serverTime);
    const dir = await runBackup();
    const state = new FolderStateStore(dir.baseDir);
    (await state.get('lastRunAt')).should.equal(expected);
    (await state.get('events.lastModifiedSince')).should.equal(expected);
    (await state.get('audit.lastModifiedSince')).should.equal(expected);

    server.requests.length = 0;
    server.serverTime += 3600;
    await runBackup();
    const incremental = server.requests.filter((u) => u.includes('modifiedSince='));
    incremental.length.should.be.above(0);
    incremental.every((u) => u.includes('modifiedSince=' + expected)).should.equal(true);
    fs.existsSync(path.join(dir.baseDir, 'events-incremental-' + Math.floor(server.serverTime) + '.json')).should.equal(true);
  });

  for (const mode of ['no-meta', 'error']) {
    it('falls back to the local clock, logs it, and completes when access-info ' +
      (mode === 'error' ? 'fails' : 'has no meta.serverTime'), async function () {
      server.accessInfo = mode;
      server.serverTime = Math.floor(Date.now() / 1000) - 86400; // must not be used
      const logs = [];
      const before = Math.floor(Date.now() / 1000);
      const dir = await runBackup(logs);
      const after = Math.floor(Date.now() / 1000);
      const lastRunAt = await new FolderStateStore(dir.baseDir).get('lastRunAt');
      lastRunAt.should.be.within(before, after);
      logs.some((m) => /using the local clock/.test(m)).should.equal(true);
    });
  }
});
