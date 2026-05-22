/*global describe, it, before, after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const should = require('should');
const manifest = require('../../src/methods/manifest');

describe('manifest', function () {
  let tmpDir;
  const noopLog = function () {};

  before(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    fs.writeFileSync(path.join(tmpDir, 'events.json'), '{"events":[{"id":"a"}]}');
    fs.writeFileSync(path.join(tmpDir, 'streams.json'), '{"streams":[]}');
    fs.mkdirSync(path.join(tmpDir, 'hf-data'));
    fs.writeFileSync(path.join(tmpDir, 'hf-data', 'a.json'), '{"data":{"points":[[0,1]]}}');
  });

  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes manifest.json with sha256 of every regular file', function (done) {
    manifest.generate(tmpDir, { version: '0.3.0', log: noopLog }, function (err, manifestPath) {
      if (err) return done(err);
      should(manifestPath).equal(path.join(tmpDir, 'manifest.json'));
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      should(m.algorithm).equal('sha256');
      should(m.version).equal('0.3.0');
      should(m.generated_at).be.a.String();
      should(m.file_count).equal(3);
      should(m.files['events.json']).be.a.String();
      should(m.files['streams.json']).be.a.String();
      should(m.files[path.join('hf-data', 'a.json')]).be.a.String();
      // Manifest must not list itself.
      should(m.files['manifest.json']).be.undefined();
      // Verify one digest against an independent computation.
      const expected = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(tmpDir, 'events.json')))
        .digest('hex');
      should(m.files['events.json']).equal(expected);
      done();
    });
  });

  it('verify() reports ok when nothing changed', function (done) {
    manifest.verify(tmpDir, function (err, result) {
      if (err) return done(err);
      should(result.ok).equal(true);
      should(result.mismatches).have.length(0);
      should(result.missing).have.length(0);
      should(result.extra).have.length(0);
      done();
    });
  });

  it('verify() reports mismatch when a file is tampered with', function (done) {
    fs.appendFileSync(path.join(tmpDir, 'events.json'), ' tampered');
    manifest.verify(tmpDir, function (err, result) {
      if (err) return done(err);
      should(result.ok).equal(false);
      should(result.mismatches).containEql('events.json');
      done();
    });
  });
});
