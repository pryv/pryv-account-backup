/*global describe, it, before, after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');

const StorageWriter = require('../../src/lib/adapters/StorageWriter');
const StateStore = require('../../src/lib/adapters/StateStore');
const NodeFsStorageWriter = require('../../src/lib/adapters/NodeFsStorageWriter');
const FolderStateStore = require('../../src/lib/adapters/FolderStateStore');
const Backup = require('../../src/lib/Backup');
const BackupDirectory = require('../../src/methods/backup-directory');

describe('lib adapters', function () {
  describe('[PAAB] StorageWriter base class', function () {
    it('throws when openWriteStream is not overridden', function () {
      const w = new StorageWriter();
      (() => w.openWriteStream('x')).should.throw(/not implemented/);
    });

    it('throws when exists is not overridden', function () {
      const w = new StorageWriter();
      (() => w.exists('x')).should.throw(/not implemented/);
    });

    it('finalizeBatch is a no-op by default (CLI-friendly)', async function () {
      const w = new StorageWriter();
      const ret = w.finalizeBatch();
      ret.should.be.a.Promise();
      await ret; // should resolve without error
    });
  });

  describe('[PAAB] StateStore base class', function () {
    it('throws when get is not overridden', async function () {
      const s = new StateStore();
      let threw = false;
      try { await s.get('k'); } catch (err) { threw = /not implemented/.test(err.message); }
      threw.should.equal(true);
    });

    it('throws when set is not overridden', async function () {
      const s = new StateStore();
      let threw = false;
      try { await s.set('k', 1); } catch (err) { threw = /not implemented/.test(err.message); }
      threw.should.equal(true);
    });
  });

  describe('[PAAB] NodeFsStorageWriter', function () {
    let tmpDir;
    let dir;

    before(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsw-test-'));
      dir = new BackupDirectory('https://token@host.example.com/', tmpDir);
    });

    after(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('constructs from a BackupDirectory (legacy back-compat)', function () {
      const w = new NodeFsStorageWriter(dir);
      w.baseDir.should.equal(dir.baseDir);
      w.legacyDirectory().should.equal(dir);
    });

    it('constructs from a baseDir string', function () {
      const subDir = path.join(tmpDir, 'string-ctor');
      const w = new NodeFsStorageWriter(subDir);
      w.baseDir.should.endWith('/');
      should(w.legacyDirectory()).equal(null);
    });

    it('rejects nullish or non-string non-BackupDirectory inputs', function () {
      (() => new NodeFsStorageWriter(null)).should.throw(/baseDir/);
      (() => new NodeFsStorageWriter({})).should.throw(/baseDir/);
    });

    it('exists() returns true after openWriteStream + end', function (done) {
      const w = new NodeFsStorageWriter(dir);
      const s = w.openWriteStream('hello.txt');
      s.write('world');
      s.end(() => {
        w.exists('hello.txt').should.equal(true);
        w.exists('nope.txt').should.equal(false);
        done();
      });
    });

    it('openWriteStream creates parent directories', function (done) {
      const w = new NodeFsStorageWriter(dir);
      const s = w.openWriteStream('deeply/nested/file.txt');
      s.write('ok');
      s.end(() => {
        w.exists('deeply/nested/file.txt').should.equal(true);
        done();
      });
    });

    it('describeTarget returns the baseDir', function () {
      const w = new NodeFsStorageWriter(dir);
      w.describeTarget().should.equal(dir.baseDir);
    });

    it('finalizeBatch is a no-op (CLI commits per-stream)', async function () {
      const w = new NodeFsStorageWriter(dir);
      await w.finalizeBatch();
    });
  });

  describe('[PAAB] FolderStateStore', function () {
    let tmpDir;

    before(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-test-'));
    });

    after(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads empty state when no sentinel file exists', async function () {
      const s = new FolderStateStore(tmpDir);
      const all = await s.getAll();
      all.should.eql({});
    });

    it('round-trips set/get and persists across instances', async function () {
      const s1 = new FolderStateStore(tmpDir);
      await s1.set('lastRunAt', 1700000000);
      await s1.set('events.lastModifiedSince', 1699000000);

      // New instance reads from disk.
      const s2 = new FolderStateStore(tmpDir);
      (await s2.get('lastRunAt')).should.equal(1700000000);
      (await s2.get('events.lastModifiedSince')).should.equal(1699000000);
    });

    it('tolerates a corrupted sentinel file (treats as empty)', async function () {
      const stateFile = path.join(tmpDir, '.sync-state.json');
      fs.writeFileSync(stateFile, '{not valid json');
      const s = new FolderStateStore(tmpDir);
      const all = await s.getAll();
      all.should.eql({});
    });

    it('getAll returns a shallow copy (mutation does not leak back)', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.set('k', 1);
      const all = await s.getAll();
      all.k = 999;
      (await s.get('k')).should.equal(1);
    });

    it('migrates from the pre-v0.7.0 .state.json layout', async function () {
      const migrateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-migrate-'));
      try {
        const legacy = path.join(migrateDir, '.state.json');
        fs.writeFileSync(legacy, JSON.stringify({
          lastRunAt: 1700000000,
          'events.lastModifiedSince': 1699000000
        }));
        const s = new FolderStateStore(migrateDir);
        (await s.get('lastRunAt')).should.equal(1700000000);
        (await s.get('events.lastModifiedSince')).should.equal(1699000000);
        // Next write lands in the new file.
        await s.set('k', 'v');
        fs.existsSync(path.join(migrateDir, '.sync-state.json')).should.equal(true);
      } finally {
        fs.rmSync(migrateDir, { recursive: true, force: true });
      }
    });
  });

  describe('[PAAB] FolderStateStore ref tracking', function () {
    let tmpDir;
    beforeEach(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-refs-'));
    });
    afterEach(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('pushRef + listPending round-trips a ref payload', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.pushRef('attachment', { key: 'e1:a1', eventId: 'e1', attId: 'a1', fileName: 'foo.bin' });
      const pending = await s.listPending('attachment');
      pending.length.should.equal(1);
      pending[0].key.should.equal('e1:a1');
      pending[0].fileName.should.equal('foo.bin');
    });

    it('pushRef is idempotent on key within a category', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.pushRef('attachment', { key: 'e1:a1', fileName: 'foo.bin' });
      await s.pushRef('attachment', { key: 'e1:a1', fileName: 'bar.bin' });
      const pending = await s.listPending('attachment');
      pending.length.should.equal(1);
      pending[0].fileName.should.equal('foo.bin');
    });

    it('markDone removes the ref from listPending', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.pushRef('attachment', { key: 'e1:a1' });
      await s.pushRef('attachment', { key: 'e2:a2' });
      await s.markDone('attachment', 'e1:a1');
      const pending = await s.listPending('attachment');
      pending.length.should.equal(1);
      pending[0].key.should.equal('e2:a2');
    });

    it('clearCategory drops every ref under the category', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.pushRef('attachment', { key: 'a' });
      await s.pushRef('webhook', { key: 'b' });
      await s.clearCategory('attachment');
      (await s.listPending('attachment')).should.eql([]);
      (await s.listPending('webhook')).length.should.equal(1);
    });

    it('refs survive across instances (persist + reload)', async function () {
      const s1 = new FolderStateStore(tmpDir);
      await s1.pushRef('attachment', { key: 'e1:a1', readToken: 'tok' });
      const s2 = new FolderStateStore(tmpDir);
      const pending = await s2.listPending('attachment');
      pending[0].readToken.should.equal('tok');
    });

    it('pushRef requires ref.key', async function () {
      const s = new FolderStateStore(tmpDir);
      let threw = false;
      try { await s.pushRef('attachment', { eventId: 'e1' }); } catch (e) { threw = /ref\.key/.test(e.message); }
      threw.should.equal(true);
    });
  });

  describe('[PAAB] FolderStateStore export / import', function () {
    let tmpDir;
    beforeEach(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-export-'));
    });
    afterEach(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('export() returns the schema envelope + kv state (refs dropped)', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.set('lastRunAt', 1700000000);
      await s.set('toolVersion', '0.7.0');
      await s.pushRef('attachment', { key: 'e1:a1' });
      const snapshot = await s.export();
      snapshot.format.should.equal('pryv-account-backup-sync-state');
      snapshot.formatVersion.should.equal(1);
      snapshot.toolVersion.should.equal('0.7.0');
      snapshot.kv.lastRunAt.should.equal(1700000000);
      should(snapshot.refs).equal(undefined);
    });

    it('import() replaces kv state from a prior snapshot', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.set('a', 1);
      await s.import({
        format: 'pryv-account-backup-sync-state',
        formatVersion: 1,
        kv: { b: 2 }
      });
      const all = await s.getAll();
      all.should.eql({ b: 2 });
    });

    it('import() rejects an unrecognized format', async function () {
      const s = new FolderStateStore(tmpDir);
      let threw = false;
      try { await s.import({ format: 'something-else', formatVersion: 1, kv: {} }); }
      catch (e) { threw = /format/.test(e.message); }
      threw.should.equal(true);
    });

    it('import() rejects an unsupported formatVersion', async function () {
      const s = new FolderStateStore(tmpDir);
      let threw = false;
      try { await s.import({ format: 'pryv-account-backup-sync-state', formatVersion: 99, kv: {} }); }
      catch (e) { threw = /formatVersion/.test(e.message); }
      threw.should.equal(true);
    });

    it('import() does NOT replace refs (those are per-run)', async function () {
      const s = new FolderStateStore(tmpDir);
      await s.pushRef('attachment', { key: 'e1:a1' });
      await s.import({
        format: 'pryv-account-backup-sync-state',
        formatVersion: 1,
        kv: {}
      });
      const pending = await s.listPending('attachment');
      pending.length.should.equal(1);
    });
  });

  describe('[PAAB] Backup class construction', function () {
    let tmpDir;
    let dir;

    before(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
      dir = new BackupDirectory('https://token@host.example.com/', tmpDir);
    });

    after(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when config is missing', function () {
      (() => new Backup()).should.throw(/config/);
    });

    it('throws when connection is missing', function () {
      const writer = new NodeFsStorageWriter(dir);
      (() => new Backup({ writer })).should.throw(/connection/);
    });

    it('throws when writer is missing', function () {
      (() => new Backup({ connection: {} })).should.throw(/writer/);
    });

    it('stores adapters and defaults options to an empty object', function () {
      const writer = new NodeFsStorageWriter(dir);
      const b = new Backup({ connection: { endpoint: 'x', token: 'y' }, writer });
      b.connection.endpoint.should.equal('x');
      b.writer.should.equal(writer);
      b.options.should.eql({});
      b.log.should.be.a.Function();
    });

    it('run() surfaces a clear error when the writer lacks a legacy BackupDirectory (Phase A constraint)', function (done) {
      const stringWriter = new NodeFsStorageWriter(path.join(tmpDir, 'string-only'));
      const b = new Backup({
        connection: { endpoint: 'x', token: 'y' },
        writer: stringWriter,
        log: () => {}
      });
      b.run((err) => {
        should.exist(err);
        err.message.should.match(/BackupDirectory/);
        done();
      });
    });
  });
});
