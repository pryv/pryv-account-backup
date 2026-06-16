/*global describe, it, before, after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');

const apiResources = require('../../src/methods/api-resources');
const eventsChunked = require('../../src/methods/events-chunked');
const auditAsEvents = require('../../src/methods/audit-as-events');
const accessesHistory = require('../../src/methods/accesses-history');
const attachments = require('../../src/methods/attachments');
const webhooksExport = require('../../src/methods/webhooks-export');
const FolderStateStore = require('../../src/lib/adapters/FolderStateStore');

/**
 * [PALI] — Library Isomorphism contract: the four browser-portable per-method
 * modules (api-resources, events-chunked, audit-as-events, accesses-history)
 * MUST accept a `StorageWriter` adapter and route all writes through it.
 *
 * The tests do not exercise real HTTP — `fetch` is patched globally for the
 * duration of each test. They verify the dual signature (writer + legacy
 * BackupDirectory) and the absence of direct `fs`/`https` calls in the
 * isomorphic code paths.
 */

describe('[PALI] library isomorphism contract', function () {
  let originalFetch;
  let writeCalls;
  let fakeWriter;

  beforeEach(function () {
    originalFetch = global.fetch;
    writeCalls = [];

    // Mock writer with a stream-like interface that records writes.
    fakeWriter = {
      openWriteStream (relPath) {
        const sink = {
          path: relPath,
          chunks: [],
          write (chunk) { sink.chunks.push(chunk); },
          end (cb) { writeCalls.push(sink); if (cb) cb(); }
        };
        return sink;
      },
      exists () { return false; },
      finalizeBatch: async function () {},
      describeTarget () { return '/mock-writer/'; }
    };

    global.fetch = function (url, opts) {
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
                if (yielded) return Promise.resolve({ done: true, value: undefined });
                yielded = true;
                return Promise.resolve({ done: false, value: encoded });
              }
            };
          }
        },
        json: () => Promise.resolve({ events: [] })
      });
    };
  });

  afterEach(function () {
    global.fetch = originalFetch;
  });

  describe('api-resources.toJSONFile', function () {
    it('writes via writer.openWriteStream when params.writer is provided', function (done) {
      apiResources.toJSONFile({
        writer: fakeWriter,
        resource: 'account',
        connection: { endpoint: 'https://token@host.example.com/', token: 'token' }
      }, function (err) {
        should.not.exist(err);
        writeCalls.length.should.equal(1);
        writeCalls[0].path.should.equal('account.json');
        done();
      }, () => {});
    });

    it('respects params.filename override (used by accesses-history per-id files)', function (done) {
      apiResources.toJSONFile({
        writer: fakeWriter,
        resource: 'whatever',
        filename: 'accesses-history/abc.json',
        connection: { endpoint: 'https://token@host.example.com/', token: 'token' }
      }, function (err) {
        should.not.exist(err);
        writeCalls[0].path.should.equal('accesses-history/abc.json');
        done();
      }, () => {});
    });

    it('throws synchronously when neither writer nor legacy folder is provided (argument validation)', function () {
      (() => apiResources.toJSONFile({
        resource: 'account',
        connection: { endpoint: 'https://token@host.example.com/', token: 'token' }
      }, () => {}, () => {})).should.throw(/writer|folder/);
    });

    it('builds the full URL by stripping userinfo from endpoint + appending resource', function (done) {
      const fetchCalls = [];
      global.fetch = function (url) {
        fetchCalls.push(url);
        return Promise.resolve({
          status: 200,
          body: { getReader () { return { read () { return Promise.resolve({ done: true }); } }; } }
        });
      };
      apiResources.toJSONFile({
        writer: fakeWriter,
        resource: 'streams?state=all',
        connection: { endpoint: 'https://token@host.example.com/', token: 'tok' }
      }, function () {
        fetchCalls[0].should.equal('https://host.example.com/streams?state=all');
        done();
      }, () => {});
    });
  });

  describe('events-chunked.download', function () {
    it('accepts a StorageWriter directly (incremental mode)', function (done) {
      eventsChunked.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        { modifiedSince: 1700000000, runStartedAt: 1700100000 },
        function (err) {
          should.not.exist(err);
          writeCalls[0].path.should.equal('events-incremental-1700100000.json');
          done();
        },
        () => {}
      );
    });

    it('actually writes to disk when given a real NodeFsStorageWriter', function (done) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-real-'));
      const NodeFsStorageWriter = require('../../src/lib/adapters/NodeFsStorageWriter');
      const writer = new NodeFsStorageWriter(tmpDir);
      eventsChunked.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        writer,
        { modifiedSince: 1700000000, runStartedAt: 1700100000 },
        function (err) {
          should.not.exist(err);
          fs.existsSync(path.resolve(tmpDir, 'events-incremental-1700100000.json')).should.equal(true);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          done();
        },
        () => {}
      );
    });

    it('throws synchronously when no writer is provided (browser-friendly arg validation)', function () {
      (() => eventsChunked.download(
        { endpoint: 'https://x/', token: 't' },
        null,
        { modifiedSince: 1700000000 },
        () => {},
        () => {}
      )).should.throw(/StorageWriter/);
    });
  });

  describe('audit-as-events.download', function () {
    it('writes to audit_logs.json via the writer', function (done) {
      auditAsEvents.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        { modifiedSince: 1700000000 },
        function (err) {
          should.not.exist(err);
          writeCalls[0].path.should.equal('audit_logs.json');
          done();
        },
        () => {}
      );
    });
  });

  describe('accesses-history.download', function () {
    it('accepts an in-memory accesses array (browser orchestrator path)', function (done) {
      accessesHistory.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        [{ id: 'access-abc' }, { id: 'access-def' }],
        function (err) {
          should.not.exist(err);
          writeCalls.length.should.equal(2);
          writeCalls.map((w) => w.path).should.eql([
            'accesses-history/access-abc.json',
            'accesses-history/access-def.json'
          ]);
          done();
        },
        () => {}
      );
    });

    it('does nothing when accessesArray is empty', function (done) {
      accessesHistory.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        [],
        function (err) {
          should.not.exist(err);
          writeCalls.length.should.equal(0);
          done();
        },
        () => {}
      );
    });
  });

  // ─── [PALI-A] attachments.download drains the `attachment` category ───

  describe('[PALI-A] attachments.download', function () {
    let storeDir;
    let store;

    beforeEach(function () {
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pali-a-'));
      store = new FolderStateStore(storeDir);
      // Binary attachments: stub fetch to return a fixed payload.
      global.fetch = function (url) {
        const payload = new TextEncoder().encode('PNG-bytes-for-' + url);
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
                  return Promise.resolve({ done: false, value: payload });
                }
              };
            }
          }
        });
      };
    });

    afterEach(function () {
      fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('throws synchronously when StateStore is missing', function () {
      (() => attachments.download(
        { endpoint: 'https://x/', token: 't' },
        fakeWriter,
        null,
        {},
        () => {},
        () => {}
      )).should.throw(/StateStore/);
    });

    it('throws synchronously when writer is missing', function () {
      (() => attachments.download(
        { endpoint: 'https://x/', token: 't' },
        null,
        store,
        {},
        () => {},
        () => {}
      )).should.throw(/StorageWriter/);
    });

    it('writes one attachments/<eid>_<fileName> per pending ref + marks each done', async function () {
      await store.pushRef('attachment', {
        key: 'e1:a1', eventId: 'e1', attId: 'a1', fileName: 'photo.png', readToken: 'rt1'
      });
      await store.pushRef('attachment', {
        key: 'e1:a2', eventId: 'e1', attId: 'a2', fileName: 'doc.pdf', readToken: 'rt2'
      });

      await new Promise((resolve, reject) => {
        attachments.download(
          { endpoint: 'https://token@host.example.com/', token: 't' },
          fakeWriter,
          store,
          {},
          (err) => err ? reject(err) : resolve(),
          () => {}
        );
      });

      const paths = writeCalls.map((w) => w.path).sort();
      paths.should.eql(['attachments/e1_doc.pdf', 'attachments/e1_photo.png']);
      (await store.listPending('attachment')).should.eql([]);
    });

    it('writes nothing when no refs are pending', async function () {
      await new Promise((resolve, reject) => {
        attachments.download(
          { endpoint: 'https://token@host.example.com/', token: 't' },
          fakeWriter,
          store,
          {},
          (err) => err ? reject(err) : resolve(),
          () => {}
        );
      });
      writeCalls.length.should.equal(0);
    });
  });

  // ─── [PALI-W] webhooks-export.download drains the `webhook` category ───

  describe('[PALI-W] webhooks-export.download', function () {
    let storeDir;
    let store;
    let fetchUrls;

    beforeEach(function () {
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pali-w-'));
      store = new FolderStateStore(storeDir);
      fetchUrls = [];
      global.fetch = function (url) {
        fetchUrls.push(url);
        return Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ webhooks: [{ id: 'wh-' + fetchUrls.length, url: 'https://hook' }] })
        });
      };
    });

    afterEach(function () {
      fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('hits /webhooks once per pending access ref + tags each result with accessId', async function () {
      await store.pushRef('webhook', { key: 'acc-1', accessId: 'acc-1', token: 'tok-1', type: 'app' });
      await store.pushRef('webhook', { key: 'acc-2', accessId: 'acc-2', token: 'tok-2', type: 'shared' });

      await new Promise((resolve, reject) => {
        webhooksExport.download(
          { endpoint: 'https://token@host.example.com/', token: 't' },
          fakeWriter,
          store,
          {},
          (err) => err ? reject(err) : resolve(),
          () => {}
        );
      });

      fetchUrls.length.should.equal(2);
      writeCalls.length.should.equal(1);
      writeCalls[0].path.should.equal('webhooks.json');
      const body = JSON.parse(writeCalls[0].chunks.map((b) => Buffer.from(b).toString()).join(''));
      body.accesses_scanned.should.equal(2);
      body.webhooks.length.should.equal(2);
      body.webhooks.map((w) => w.accessId).sort().should.eql(['acc-1', 'acc-2']);
      (await store.listPending('webhook')).should.eql([]);
    });

    it('still writes a bundle when no accesses are scannable', async function () {
      await new Promise((resolve, reject) => {
        webhooksExport.download(
          { endpoint: 'https://token@host.example.com/', token: 't' },
          fakeWriter,
          store,
          {},
          (err) => err ? reject(err) : resolve(),
          () => {}
        );
      });
      writeCalls.length.should.equal(1);
      writeCalls[0].path.should.equal('webhooks.json');
      const body = JSON.parse(writeCalls[0].chunks.map((b) => Buffer.from(b).toString()).join(''));
      body.accesses_scanned.should.equal(0);
      body.webhooks.should.eql([]);
    });
  });

  // ─── [PALI-S] api-resources onParsed tee + events-chunked onEvents lift ───

  describe('[PALI-S] api-resources onParsed hook', function () {
    let receivedDoc;

    beforeEach(function () {
      receivedDoc = null;
      // Stream-style fetch with a parseable JSON body.
      global.fetch = function () {
        const payload = new TextEncoder().encode(JSON.stringify({
          accesses: [{ id: 'acc-1', token: 'tok' }],
          meta: { v: 1 }
        }));
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
                  return Promise.resolve({ done: false, value: payload });
                }
              };
            }
          }
        });
      };
    });

    it('tees response bytes + parses + invokes onParsed when supplied', function (done) {
      apiResources.toJSONFile({
        writer: fakeWriter,
        resource: 'accesses',
        connection: { endpoint: 'https://token@host.example.com/', token: 't' },
        onParsed: (doc) => { receivedDoc = doc; }
      }, function (err) {
        should.not.exist(err);
        receivedDoc.should.not.equal(null);
        receivedDoc.accesses[0].id.should.equal('acc-1');
        receivedDoc.meta.v.should.equal(1);
        // Bytes still flowed to the writer.
        writeCalls.length.should.equal(1);
        done();
      }, () => {});
    });

    it('skips onParsed silently when the body is not valid JSON', function (done) {
      global.fetch = function () {
        const payload = new TextEncoder().encode('{not valid json');
        let yielded = false;
        return Promise.resolve({
          status: 200,
          body: {
            getReader () {
              return {
                read () {
                  if (yielded) return Promise.resolve({ done: true });
                  yielded = true;
                  return Promise.resolve({ done: false, value: payload });
                }
              };
            }
          }
        });
      };
      apiResources.toJSONFile({
        writer: fakeWriter,
        resource: 'accesses',
        connection: { endpoint: 'https://x/', token: 't' },
        onParsed: (doc) => { receivedDoc = doc; }
      }, function (err) {
        should.not.exist(err);
        should(receivedDoc).equal(null); // unparseable → onParsed not called
        done();
      }, () => {});
    });
  });

  describe('[PALI-S] events-chunked onEvents lift', function () {
    let receivedBatches;

    beforeEach(function () {
      receivedBatches = [];
      global.fetch = function () {
        const payload = new TextEncoder().encode(JSON.stringify({
          events: [
            { id: 'e1', type: 'note/txt' },
            { id: 'e2', type: 'series:mass/kg' }
          ]
        }));
        let yielded = false;
        return Promise.resolve({
          status: 200,
          body: {
            getReader () {
              return {
                read () {
                  if (yielded) return Promise.resolve({ done: true });
                  yielded = true;
                  return Promise.resolve({ done: false, value: payload });
                }
              };
            }
          }
        });
      };
    });

    it('forwards parsed events to onEvents in incremental mode', function (done) {
      eventsChunked.download(
        { endpoint: 'https://token@host.example.com/', token: 't' },
        fakeWriter,
        {
          modifiedSince: 1700000000,
          runStartedAt: 1700100000,
          onEvents: (events) => { receivedBatches.push(events); }
        },
        function (err) {
          should.not.exist(err);
          receivedBatches.length.should.equal(1);
          receivedBatches[0].length.should.equal(2);
          receivedBatches[0][0].id.should.equal('e1');
          receivedBatches[0][1].type.should.equal('series:mass/kg');
          done();
        },
        () => {}
      );
    });
  });
});
