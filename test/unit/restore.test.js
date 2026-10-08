/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */
/* global describe, it, beforeEach, afterEach */

// Offline tests for restore: a fake connection answers each batched call and
// records what was sent, so the assertions are on the calls that reach the
// server (what restore writes) and on the report (what it tells the user).

const fs = require('fs');
const os = require('os');
const path = require('path');
const should = require('should');
const restore = require('../../src/restore');

function fakeConnection (answer) {
  const sent = [];
  return {
    sent,
    async api (calls) {
      const results = [];
      for (const call of calls) {
        sent.push(call);
        results.push(answer(call.method, call.params));
      }
      return results;
    },
    methods () { return sent.map((c) => c.method); },
    callsTo (method) { return sent.filter((c) => c.method === method); }
  };
}

const TARGET_ACCOUNT = {
  username: 'target',
  email: 'target@example.com',
  language: 'en',
  emails: [{ value: 'target@example.com', primary: true, status: 'verified' }]
};

// Default server behaviour: everything succeeds, the target account above.
function defaultAnswer (method, params) {
  if (method === 'account.get') return { account: TARGET_ACCOUNT };
  if (method === 'account.update') return { account: {} };
  if (method === 'events.get') return { events: [] };
  if (method === 'events.update') return { event: { id: params.id } };
  if (method === 'events.create') return { event: { id: params.id || 'new' } };
  if (method === 'streams.create') return { stream: { id: params.id } };
  return { error: { id: 'unknown-method', message: method } };
}

function writeBackup (dir, { streams, events, account }) {
  fs.writeFileSync(path.join(dir, 'streams.json'), JSON.stringify({ streams }));
  fs.writeFileSync(path.join(dir, 'events-2026-10.json'), JSON.stringify({ events }));
  if (account) fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ account }));
}

const ACCOUNT_STREAMS = [
  {
    id: ':_system:account',
    name: 'Account',
    children: [
      { id: ':_system:language', name: 'Language' },
      { id: ':system:email', name: 'Email' },
      { id: ':system:phone', name: 'Phone' }
    ]
  }
];

const ACCOUNT_EVENTS = [
  { id: 'ev-email', streamIds: [':system:email'], type: 'email/string', content: 'source@example.com', time: 1, modified: 5 },
  { id: 'ev-lang', streamIds: [':_system:language'], type: 'language/iso-639-1', content: 'fr', time: 1, modified: 5 },
  { id: 'ev-storage', streamIds: [':_system:dbDocuments'], type: 'data-quantity/b', content: 12, time: 1, modified: 5 },
  { id: 'ev-phone-old', streamIds: [':system:phone'], type: 'phone/string', content: '+41 00', time: 1, modified: 2 },
  { id: 'ev-phone', streamIds: [':system:phone'], type: 'phone/string', content: '+41 11', time: 1, modified: 6 }
];

describe('[RSTR] restore', function () {
  let tmp, backupDir, previousCwd;

  beforeEach(function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-restore-'));
    backupDir = path.join(tmp, 'backup');
    fs.mkdirSync(backupDir);
    previousCwd = process.cwd();
    process.chdir(tmp); // restore writes res_*.log to the working directory
  });

  afterEach(function () {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('[RSER] refused calls', function () {
    it('[RSE1] reports every refused call of a batch and fails the report', async function () {
      writeBackup(backupDir, {
        streams: [{ id: 'diary', name: 'Diary' }, { id: 'health', name: 'Health' }],
        events: [
          { id: 'e1', streamIds: ['diary'], type: 'note/txt', content: 'a', time: 1 },
          { id: 'e2', streamIds: ['diary'], type: 'note/txt', content: 'b', time: 2 }
        ]
      });
      const conn = fakeConnection((method, params) => {
        if (method === 'streams.create' && params.id === 'health') {
          return { error: { id: 'item-already-exists', message: 'stream exists' } };
        }
        if (method === 'events.create' && params.id === 'e2') {
          return { error: { id: 'invalid-parameters-format', message: 'bad content' } };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir);
      report.hasFailures().should.equal(true);
      report.failureCount().should.equal(2);
      report.resources.streams.failed.map((f) => f.id).should.eql(['health']);
      report.resources.events.failed.map((f) => f.id).should.eql(['e2']);
      report.resources.events.failed[0].error.id.should.equal('invalid-parameters-format');
      const text = report.toLines().join('\n');
      text.should.match(/streams: 1 ok, 1 refused/);
      text.should.match(/refused e2: invalid-parameters-format: bad content/);
      fs.existsSync(path.join(tmp, 'res_events.log')).should.equal(true);
    });

    it('[RSE2] a call answered with nothing counts as refused', async function () {
      writeBackup(backupDir, {
        streams: [{ id: 'diary', name: 'Diary' }],
        events: [{ id: 'e1', streamIds: ['diary'], type: 'note/txt', content: 'a', time: 1 }]
      });
      const conn = fakeConnection((method, params) =>
        method === 'events.create' ? null : defaultAnswer(method, params));
      const report = await restore(conn, backupDir);
      report.failureCount().should.equal(1);
      report.resources.events.failed[0].error.id.should.equal('no-result');
    });

    it('[RSE3] a clean restore has no failures', async function () {
      writeBackup(backupDir, {
        streams: [{ id: 'diary', name: 'Diary' }],
        events: [{ id: 'e1', streamIds: ['diary'], type: 'note/txt', content: 'a', time: 1 }]
      });
      const report = await restore(fakeConnection(defaultAnswer), backupDir);
      report.hasFailures().should.equal(false);
    });
  });

  describe('[RSNS] server-managed namespaces', function () {
    it('[RSN1] never creates a ":"-prefixed stream or event, keeps the rest', async function () {
      writeBackup(backupDir, {
        streams: ACCOUNT_STREAMS.concat([
          { id: 'diary', name: 'Diary', children: [{ id: 'diary-sub', name: 'Sub' }] },
          { id: ':_audit:accesses', name: 'Audit' },
          { id: '.legacy', name: 'Legacy' }
        ]),
        events: ACCOUNT_EVENTS.concat([
          { id: 'e1', streamIds: ['diary'], type: 'note/txt', content: 'a', time: 1 },
          { id: 'e2', streamIds: ['diary-sub', ':_audit:accesses'], type: 'note/txt', content: 'b', time: 2 }
        ])
      });
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir);

      conn.callsTo('streams.create').map((c) => c.params.id).should.eql(['diary', 'diary-sub']);
      const created = conn.callsTo('events.create');
      created.map((c) => c.params.id).should.eql(['e1', 'e2']);
      created[1].params.streamIds.should.eql(['diary-sub']);
      for (const call of created) {
        call.params.streamIds.filter((s) => s.startsWith(':')).should.be.empty();
      }
      report.resources.streams.skipped.map((s) => s.id).should.eql([':_system:account', ':_audit:accesses', '.legacy']);
      report.notes.join('\n').should.match(/5 event\(s\) only in system or server-managed streams were not replayed/);
    });

    it('[RSN3] restores legacy streamId-only events and skips events with no stream', async function () {
      writeBackup(backupDir, {
        streams: [{ id: 'diary', name: 'Diary' }],
        events: [
          { id: 'old', streamId: 'diary', type: 'note/txt', content: 'legacy', time: 1 },
          { id: 'none', type: 'note/txt', content: 'orphan', time: 2 }
        ]
      });
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir);
      const created = conn.callsTo('events.create');
      created.map((c) => [c.params.id, c.params.streamIds]).should.eql([['old', ['diary']]]);
      should.not.exist(created[0].params.streamId);
      report.resources.events.skipped.map((s) => s.id).should.eql(['none']);
    });

    it('[RSN2] isRestorableStreamId', function () {
      restore.isRestorableStreamId('diary').should.equal(true);
      restore.isRestorableStreamId(':system:email').should.equal(false);
      restore.isRestorableStreamId(':_system:language').should.equal(false);
      restore.isRestorableStreamId(':_audit:actions').should.equal(false);
      restore.isRestorableStreamId('.legacy').should.equal(false);
    });
  });

  describe('[RSDU] incremental backups', function () {
    it('[RSD1] restores the latest version of each event once and skips deleted ones', async function () {
      writeBackup(backupDir, {
        streams: [{ id: 'diary', name: 'Diary' }],
        events: [
          { id: 'e1', streamIds: ['diary'], type: 'note/txt', content: 'old', time: 1, modified: 10 },
          { id: 'e2', streamIds: ['diary'], type: 'note/txt', content: 'kept', time: 2, modified: 10 },
          { id: 'e3', streamIds: ['diary'], type: 'note/txt', content: 'later deleted', time: 3, modified: 10 }
        ]
      });
      // Shape of an `events?modifiedSince=T&includeDeletions=true` body:
      // deletions come in their own `eventDeletions` list.
      fs.writeFileSync(path.join(backupDir, 'events-incremental-20.json'), JSON.stringify({
        events: [
          { id: 'e1', streamIds: ['diary'], type: 'note/txt', content: 'new', time: 1, modified: 20 }
        ],
        eventDeletions: [{ id: 'e3', deleted: 20 }]
      }));
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir);
      conn.callsTo('events.create').map((c) => [c.params.id, c.params.content])
        .should.eql([['e1', 'new'], ['e2', 'kept']]);
      report.hasFailures().should.equal(false);
    });

    it('[RSD2] an older copy read after a newer one does not win', function () {
      restore.latestEventVersions([
        { id: 'e1', content: 'new', modified: 20 },
        { id: 'e1', content: 'old', modified: 10 }
      ]).map((e) => e.content).should.eql(['new']);
    });
  });

  describe('[RSAC] account fields', function () {
    const SOURCE_ACCOUNT = {
      username: 'source',
      email: 'source@example.com',
      language: 'fr',
      emails: [
        { value: 'source@example.com', primary: true, status: 'verified', verifiedAt: 1700000000 },
        { value: 'second@example.com', primary: false, status: 'pending' }
      ]
    };

    function backupWithAccount (account) {
      writeBackup(backupDir, { streams: ACCOUNT_STREAMS, events: ACCOUNT_EVENTS, account });
    }

    it('[RSA1] restores language and primary email through account.update', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir);
      const updates = conn.callsTo('account.update').map((c) => c.params.update);
      updates.should.containEql({ language: 'fr' });
      updates.should.containEql({ email: 'source@example.com' });
      // The language and email events themselves are never replayed.
      conn.callsTo('events.create').should.be.empty();
      report.hasFailures().should.equal(false);
    });

    it('[RSA2] sends nothing when the target already holds the values', async function () {
      backupWithAccount(Object.assign({}, SOURCE_ACCOUNT, {
        email: 'target@example.com',
        language: 'en',
        emails: [{ value: 'target@example.com', primary: true, status: 'verified' }]
      }));
      const conn = fakeConnection(defaultAnswer);
      await restore(conn, backupDir);
      conn.callsTo('account.update').should.be.empty();
    });

    it('[RSA3] a primary email taken on the target is reported, not a failure', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection((method, params) => {
        if (method === 'account.update' && params.update.email) {
          return { error: { id: 'item-already-exists', message: 'email taken' } };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir);
      report.hasFailures().should.equal(false);
      report.resources.account.skipped.map((s) => s.id).should.containEql('email source@example.com');
      // The language update still went through.
      conn.callsTo('account.update').map((c) => c.params.update).should.containEql({ language: 'fr' });
    });

    it('[RSA4] another account.update refusal is a failure', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection((method, params) => {
        if (method === 'account.update' && params.update.language) {
          return { error: { id: 'invalid-parameters-format', message: 'bad language' } };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir);
      report.resources.account.failed.map((f) => f.id).should.eql(['language']);
    });

    it('[RSA5] additional addresses are not re-added unless asked', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir);
      conn.callsTo('account.update').filter((c) => c.params.update.emails).should.be.empty();
      const skipped = report.resources.account.skipped.find((s) => s.id === 'email second@example.com');
      should.exist(skipped);
      skipped.reason.should.match(/--restore-secondary-emails/);
    });

    it('[RSA6] with restoreSecondaryEmails, each address is added as pending in its own call', async function () {
      backupWithAccount(Object.assign({}, SOURCE_ACCOUNT, {
        emails: SOURCE_ACCOUNT.emails.concat([{ value: 'third@example.com', primary: false, status: 'pending' }])
      }));
      const conn = fakeConnection(defaultAnswer);
      await restore(conn, backupDir, { restoreSecondaryEmails: true });
      const adds = conn.callsTo('account.update')
        .filter((c) => c.params.update.emails)
        .map((c) => c.params.update.emails.add);
      adds.should.eql([['second@example.com'], ['third@example.com']]);
    });

    it('[RSA9] an address already on the target is not added again', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection((method, params) => {
        if (method === 'account.get') {
          return {
            account: Object.assign({}, TARGET_ACCOUNT, {
              emails: TARGET_ACCOUNT.emails.concat([{ value: 'second@example.com', primary: false, status: 'pending' }])
            })
          };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir, { restoreSecondaryEmails: true });
      conn.callsTo('account.update').filter((c) => c.params.update.emails).should.be.empty();
      const skipped = report.resources.account.skipped.find((s) => s.id === 'email second@example.com');
      skipped.reason.should.equal('already on the target account');
    });

    it('[RSAG] a refused account.get is a failure and nothing is written to the account', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection((method, params) =>
        method === 'account.get' ? { error: { id: 'forbidden', message: 'no' } } : defaultAnswer(method, params));
      const report = await restore(conn, backupDir);
      conn.callsTo('account.update').should.be.empty();
      conn.callsTo('events.update').should.be.empty();
      report.resources.account.failed.map((f) => f.id).should.eql(['account.get']);
    });

    it('[RSA7] verification state is printed, never sent', async function () {
      backupWithAccount(SOURCE_ACCOUNT);
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir, { restoreSecondaryEmails: true });
      for (const call of conn.callsTo('account.update')) {
        JSON.stringify(call.params).should.not.match(/status|verifiedAt|verified/);
      }
      report.notes.join('\n').should.match(/source@example.com \(primary\): status in the backup "verified", verified at 2023-11-14T22:13:20.000Z; verification state is not restored/);
    });

    it('[RSA8] without account.json, no account.update and a note', async function () {
      backupWithAccount(null);
      const conn = fakeConnection(defaultAnswer);
      const report = await restore(conn, backupDir);
      conn.callsTo('account.update').should.be.empty();
      report.notes.join('\n').should.match(/no account.json/);
    });
  });

  describe('[RSCF] operator-declared account fields', function () {
    function backupWithPhone () {
      writeBackup(backupDir, { streams: ACCOUNT_STREAMS, events: ACCOUNT_EVENTS, account: null });
    }

    it('[RSC1] updates the target\'s existing event with the latest exported value', async function () {
      backupWithPhone();
      const conn = fakeConnection((method, params) => {
        if (method === 'events.get' && params.streams[0] === ':system:phone') {
          return { events: [{ id: 'target-phone', streamIds: [':system:phone'], content: '+41 99' }] };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir);
      conn.callsTo('events.get').map((c) => c.params.streams).should.eql([[':system:phone']]);
      conn.callsTo('events.update').map((c) => c.params).should.eql([
        { id: 'target-phone', update: { content: '+41 11' } }
      ]);
      report.hasFailures().should.equal(false);
    });

    it('[RSC2] a field not editable on the target is skipped, not a failure', async function () {
      backupWithPhone();
      const conn = fakeConnection((method, params) => {
        if (method === 'events.get') return { events: [{ id: 'target-phone', content: '+41 99' }] };
        if (method === 'events.update') {
          return { error: { id: 'invalid-operation', message: 'Forbidden event modification.', data: { streamId: ':system:phone' } } };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir);
      report.hasFailures().should.equal(false);
      const skipped = report.resources.account.skipped.find((s) => s.id === ':system:phone');
      skipped.reason.should.match(/not editable/);
    });

    it('[RSC5] an invalid-operation refusal about another stream is a failure', async function () {
      backupWithPhone();
      const conn = fakeConnection((method, params) => {
        if (method === 'events.get') return { events: [{ id: 'target-phone', content: '+41 99' }] };
        if (method === 'events.update') {
          return { error: { id: 'invalid-operation', message: 'something else', data: { streamId: ':system:other' } } };
        }
        return defaultAnswer(method, params);
      });
      const report = await restore(conn, backupDir);
      report.resources.account.failed.map((f) => f.id).should.eql([':system:phone']);
    });

    it('[RSC3] skips a field the target lacks or already holds', async function () {
      backupWithPhone();
      let conn = fakeConnection((method, params) =>
        method === 'events.get' ? { events: [] } : defaultAnswer(method, params));
      let report = await restore(conn, backupDir);
      conn.callsTo('events.update').should.be.empty();
      report.resources.account.skipped.map((s) => s.id).should.containEql(':system:phone');

      writeBackup(backupDir, { streams: ACCOUNT_STREAMS, events: ACCOUNT_EVENTS, account: null });
      conn = fakeConnection((method, params) =>
        method === 'events.get' ? { events: [{ id: 'p', content: '+41 11' }] } : defaultAnswer(method, params));
      report = await restore(conn, backupDir);
      conn.callsTo('events.update').should.be.empty();
    });

    it('[RSC4] ignores the primary email and deleted entries', function () {
      const byStream = restore.customAccountFieldEvents(ACCOUNT_EVENTS.concat([
        { id: 'gone', streamIds: [':system:fax'], deleted: 10 },
        { id: 'binned', streamIds: [':system:pager'], content: 'x', trashed: true, modified: 9 }
      ]));
      [...byStream.keys()].should.eql([':system:phone']);
      byStream.get(':system:phone').id.should.equal('ev-phone');
    });
  });
});
