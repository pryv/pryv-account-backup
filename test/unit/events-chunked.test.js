/*global describe, it, before, after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');
const eventsChunked = require('../../src/methods/events-chunked');
const Directory = require('../../src/methods/backup-directory');

// Time helpers — work in UTC seconds since epoch.
function utcSec (y, m, d, h, mi, s) {
  return Math.floor(Date.UTC(y, m - 1, d || 1, h || 0, mi || 0, s || 0) / 1000);
}

describe('events-chunked', function () {
  describe('[PACE] computeMonthlyWindows', function () {
    it('produces one window per month in the discovered range', function () {
      const from = utcSec(2024, 1, 5, 12); // 2024-01-05T12:00:00Z
      const to = utcSec(2024, 3, 20, 8); // 2024-03-20T08:00:00Z
      const windows = eventsChunked._computeMonthlyWindows(from, to, 1);
      windows.should.have.length(3);
      windows[0].label.should.equal('2024-01');
      windows[1].label.should.equal('2024-02');
      windows[2].label.should.equal('2024-03');
    });

    it('aligns windows to UTC month boundaries with no overlap or gap', function () {
      const from = utcSec(2024, 1, 5);
      const to = utcSec(2024, 3, 20);
      const windows = eventsChunked._computeMonthlyWindows(from, to, 1);
      for (let i = 1; i < windows.length; i++) {
        // Adjacent windows touch: prev.to + 1 == next.from.
        (windows[i].from - windows[i - 1].to).should.equal(1);
      }
    });

    it('clips the first window to the discovered fromTime (no lookback)', function () {
      const from = utcSec(2024, 1, 15); // mid-month
      const to = utcSec(2024, 2, 5);
      const windows = eventsChunked._computeMonthlyWindows(from, to, 1);
      windows[0].from.should.equal(from);
      windows[0].label.should.equal('2024-01');
    });

    it('clips the last window to the discovered toTime', function () {
      const from = utcSec(2024, 1, 5);
      const to = utcSec(2024, 2, 10); // mid-month
      const windows = eventsChunked._computeMonthlyWindows(from, to, 1);
      const last = windows[windows.length - 1];
      last.to.should.equal(to);
    });

    it('honors chunkMonths > 1', function () {
      const from = utcSec(2024, 1, 1);
      const to = utcSec(2024, 6, 30);
      const windows = eventsChunked._computeMonthlyWindows(from, to, 3); // quarterly
      windows.should.have.length(2);
      windows[0].label.should.equal('2024-01');
      windows[1].label.should.equal('2024-04');
    });

    it('emits a single window when from == to (instant subject)', function () {
      const t = utcSec(2024, 6, 15);
      const windows = eventsChunked._computeMonthlyWindows(t, t, 1);
      windows.should.have.length(1);
      windows[0].from.should.equal(t);
      windows[0].to.should.equal(t);
    });

    it('crosses year boundary correctly', function () {
      const from = utcSec(2023, 11, 15);
      const to = utcSec(2024, 2, 10);
      const windows = eventsChunked._computeMonthlyWindows(from, to, 1);
      windows.map((w) => w.label).should.eql([
        '2023-11', '2023-12', '2024-01', '2024-02'
      ]);
    });
  });

  describe('[PACE] formatLabel', function () {
    it('zero-pads the month', function () {
      eventsChunked._formatLabel(new Date(Date.UTC(2024, 0, 1))).should.equal('2024-01');
      eventsChunked._formatLabel(new Date(Date.UTC(2024, 8, 1))).should.equal('2024-09');
      eventsChunked._formatLabel(new Date(Date.UTC(2024, 11, 1))).should.equal('2024-12');
    });
  });

  describe('[PACE] backup-directory chunk discovery', function () {
    let tmpDir;
    let dir;

    before(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-test-'));
      // BackupDirectory derives baseDir from the apiEndpoint hostname; pass a
      // synthetic endpoint that yields a known subdirectory.
      dir = new Directory('https://token@host.example.com/', tmpDir);
      fs.mkdirSync(dir.baseDir, { recursive: true });
    });

    after(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('hasEventsData returns false on an empty directory', function () {
      dir.hasEventsData().should.equal(false);
    });

    it('hasEventsData returns true when a chunk file is present', function () {
      fs.writeFileSync(path.join(dir.baseDir, 'events-2024-01.json'), '{"events":[]}');
      dir.hasEventsData().should.equal(true);
    });

    it('listEventFiles returns chunk files in sorted order', function () {
      fs.writeFileSync(path.join(dir.baseDir, 'events-2024-03.json'), '{"events":[]}');
      fs.writeFileSync(path.join(dir.baseDir, 'events-2024-02.json'), '{"events":[]}');
      const files = dir.listEventFiles().map((f) => path.basename(f));
      files.should.eql([
        'events-2024-01.json',
        'events-2024-02.json',
        'events-2024-03.json'
      ]);
    });

    it('listEventFiles includes legacy events.json before chunks', function () {
      fs.writeFileSync(path.join(dir.baseDir, 'events.json'), '{"events":[]}');
      const files = dir.listEventFiles().map((f) => path.basename(f));
      files[0].should.equal('events.json');
      files.slice(1).should.eql([
        'events-2024-01.json',
        'events-2024-02.json',
        'events-2024-03.json'
      ]);
    });
  });

  describe('[PAVH] accesses-all path in BackupDirectory', function () {
    let tmpDir;
    let dir;

    before(function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accesses-all-test-'));
      dir = new Directory('https://token@host.example.com/', tmpDir);
      fs.mkdirSync(dir.baseDir, { recursive: true });
    });

    after(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exposes accessesAllFile alongside accessesFile', function () {
      dir.accessesFile.should.endWith('/accesses.json');
      dir.accessesAllFile.should.endWith('/accesses-all.json');
      dir.accessesAllFile.should.not.equal(dir.accessesFile);
    });

    it('exposes accessesHistoryDir for per-access version files', function () {
      dir.accessesHistoryDir.should.endWith('/accesses-history/');
    });
  });
});
