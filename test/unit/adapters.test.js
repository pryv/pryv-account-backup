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
      const stateFile = path.join(tmpDir, '.state.json');
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
