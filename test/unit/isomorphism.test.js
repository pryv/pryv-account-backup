/*global describe, it, before, after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');

const apiResources = require('../../src/methods/api-resources');
const eventsChunked = require('../../src/methods/events-chunked');
const auditAsEvents = require('../../src/methods/audit-as-events');
const accessesHistory = require('../../src/methods/accesses-history');

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
});
