/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/* global describe, it, before, after */

const Directory = require('../../src/methods/backup-directory');
const testuser = require('../helpers/testuser');
const credentials = testuser.credentials;
const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');
const Pryv = require('pryv');

describe('backup-directory (offline)', function () {
  let tmp;

  before(function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-dir-'));
  });

  after(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('[BDA1] creates the stream folder for an attachment of a mapped stream', function () {
    const dir = new Directory('https://user.example.com/', tmp);
    dir.streamsMap.diary = 'diary/sub';
    const attFile = dir.getAttachmentFilePath('note.txt', 'ev1', 'diary');
    const attPath = path.resolve(dir.attachmentsDir, 'diary/sub');
    attFile.should.equal(path.resolve(attPath, 'ev1_note.txt'));
    fs.statSync(attPath).isDirectory().should.equal(true);
  });

  it('[BDA2] an unmapped stream keeps the flat attachments path', function () {
    const dir = new Directory('https://user.example.com/', tmp);
    dir.getAttachmentFilePath('note.txt', 'ev2', 'other')
      .should.equal(path.resolve(dir.attachmentsDir, 'ev2_note.txt'));
  });
});

describe('backup-directory', function () {
  let BackupDirectory = null;

  before(function (done) {
    if (!testuser.requireLiveAccount(this, 'backup-directory')) return;
    const service = new Pryv.Service(credentials.serviceInfoUrl);
    service.login(credentials.username, credentials.password, 'bkp-test').then((connection) => {
      BackupDirectory = new Directory(connection.apiEndpoint);
      BackupDirectory.deleteDirs(done);
    }, done);
  });

  after(function (done) {
    if (!BackupDirectory) return done();
    BackupDirectory.deleteDirs(done);
  });

  it('should create and delete the backup directories', function (done) {
    should.exists(BackupDirectory.baseDir);
    should.exists(BackupDirectory.attachmentsDir);
    should.exists(BackupDirectory.eventsFile);
    BackupDirectory.createDirs(function (err) {
      should.not.exists(err);
      fs.existsSync(BackupDirectory.baseDir).should.equal(true);
      fs.existsSync(BackupDirectory.attachmentsDir).should.equal(true);
      BackupDirectory.deleteDirs(function (err) {
        should.not.exists(err);
        fs.existsSync(BackupDirectory.baseDir).should.equal(false);
        fs.existsSync(BackupDirectory.attachmentsDir).should.equal(false);
        done();
      });
    });
  });
});
