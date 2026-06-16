# Pryv.io account backup

<!--
[![Build Status](https://travis-ci.org/pryv/pryv-account-backup.svg?branch=master)](https://travis-ci.org/pryv/pryv-account-backup)
[![Coverage Status](https://coveralls.io/repos/github/pryv/pryv-account-backup/badge.svg?branch=master)](https://coveralls.io/github/pryv/pryv-account-backup?branch=master)
-->

Simple script to backup your Pryv.io data — also a programmatic library consumed by the operator-hosted sample web app [`pryv-account-backup-webapp`](https://github.com/pryv/pryv-account-backup-webapp) when non-technical subjects need a one-click "Start backup" UX.

Two flavors, one library:

- **CLI** (`npm start`) — this repo. Canonical flavor; produces a folder of JSON + binary files plus a per-file sha256 integrity manifest for third-party auditors.
- **Sample web app** — [`pryv-account-backup-webapp`](https://github.com/pryv/pryv-account-backup-webapp). Operator-hosted; subjects log in via a form and download a series of subject-portable ZIP files. Same coverage as the CLI minus the auditor-facing manifest.

## Script Usage

*Prerequisites:* [Node](https://nodejs.org/en/) 18 or newer (required since 0.4.0 — uses native `FormData` + `fs.openAsBlob`).

In your terminal, run the following commands:

`git clone https://github.com/pryv/pryv-account-backup.git` to download the script

`cd pryv-account-backup` to go in the script folder

`npm install` to download required dependencies

`npm start` to launch the backup script.

This will ask you for the **service-info url**, **username** and **password** of the Pryv account you wish to back up.

You can finally choose to backup also trashed data as well as attachment files.

### Format

Your data will be downloaded in `./backup/{apiEndpoint}/`

This downloads the following in JSON format:
* Public profile
* Accesses — current-snapshot `accesses.json` **plus `accesses-all.json` (revoked + expired) since 0.5.0**, and optional **`accesses-history/<accessId>.json`** per access (via `?includeHistory=true`, opt-in CLI prompt) for the full disclosure-history view (consent-state-at-time-of-access provenance)
* Streams
* Events — **chunked by UTC month into `events-YYYY-MM.json` files since 0.5.0** so multi-GB subjects don't time out the single round-trip; older backups stay in a single `events.json` and restore cleanly
* Account Info
* **Audit log** (`audit_logs.json`) — every audited operation on the subject (added in 0.3.0)
* **Webhooks** per access (`webhooks.json`, keyed by `accessId`) — added in 0.3.0

As well as the following in binary files:
* Attachment files (when `includeAttachments: true`) — written to `attachments/<eventId>_<fileName>` (flat layout since 0.7.0)
* **High-frequency series data points** (`hf-data/<eventId>.json`, one per `series:*` event) — added in 0.3.0

Finally, a **per-file integrity manifest** is written to `manifest.json` — sha256 of every other file in the backup, plus tool version + ISO generation timestamp. A third party reading the backup tarball can re-hash each file and compare to detect truncation, corruption, or tampering mid-flight. The `manifest.verify(rootDir, cb)` helper does this programmatically.

A **portable `sync-state.json`** is also written at the root of the backup directory — kv state (incremental thresholds + tool version) only, suitable for moving the disclosure across machines or driving the next run from a different baseDir. The CLI auto-reads it on the next run; the sample webapp accepts it as an upload on its login screen. Schema: [`docs/sync-state.md`](docs/sync-state.md).

### Running conditions

The operation might take a while in case the data size is substantial. Please, leave requests [here](https://github.com/pryv/pryv-account-backup/issues)

## Use as a library

`@pryv/account-backup` is consumable as a programmatic library in addition to the CLI. The sample webapp [`pryv-account-backup-webapp`](https://github.com/pryv/pryv-account-backup-webapp) uses this surface; custom tools (migration scripts, Pryv-to-Pryv transfer flows, integration tests) can do the same.

The package is git-clone-distributed — **not on the npm registry**. Pin to a tag via:

```json
{
  "dependencies": {
    "pryv-account-backup": "github:pryv/pryv-account-backup#v0.7.0"
  }
}
```

### Two API surfaces

**Legacy callback API** (preserved through every release; what the CLI uses internally):

```javascript
const backup = require('pryv-account-backup');

backup.start({
  service: SERVICE_INFO_URL,
  username: USERNAME,
  password: PASSWORD,
  includeTrashed: true,                  // default false
  includeAttachments: true,              // default false
  includeAccessHistory: false,           // opt-in (O(N) calls)
  eventsChunkMonths: 1,                  // initial chunked-fetch granularity
  backupDirectory: new backup.Directory(API_ENDPOINT)
}, (err) => {
  // ...
});
```

**Class-based API** (v0.6.0+, the entry point library consumers should prefer):

```javascript
const {
  Backup,
  NodeFsStorageWriter,
  FolderStateStore
} = require('pryv-account-backup');

const writer = new NodeFsStorageWriter(backupDirectory);
const state  = new FolderStateStore(backupDirectory.baseDir);
const backup = new Backup({
  connection,       // a pryv.Connection (logged-in via Service.login)
  writer,
  state,
  options: { includeTrashed: true, includeAttachments: true, eventsChunkMonths: 1 }
});

backup.run((err) => {
  // ...
});
```

The class form decouples **what the backup does** (orchestration) from **where the output lands** (`StorageWriter` adapter) and **how incremental state is tracked** (`StateStore` adapter). Custom adapters let library consumers target alternative outputs — the sample webapp swaps `NodeFsStorageWriter` for a browser-side `BrowserBlobZipStorageWriter` and `FolderStateStore` for `LocalStorageStateStore`.

### Incremental backup

On the second and subsequent runs against the same backup directory, the orchestrator reads `.sync-state.json` (the hidden operational store, written at the end of every successful run; auto-migrated from a pre-v0.7.0 `.state.json` if present), fetches events + audit-log entries via `events.get?modifiedSince=T&includeDeletions=true`, and writes a single `events-incremental-<TS>.json` (rather than re-chunking the full history). Small resources (`account`, `streams`, `accesses`, `profile`, `webhooks`) are still full-re-fetched — they're tiny.

For cross-session / cross-machine portability, the visible companion `sync-state.json` (no leading dot) is also written at the end of each run via the `StorageWriter`. The sample webapp uses this same file as a downloadable + re-uploadable artefact to drive true cross-browser incremental. Full schema at [`docs/sync-state.md`](docs/sync-state.md).

### Audit log via the standard events API

Since v0.6.0 the audit log is fetched via `events.get?streams=[":_audit:accesses",":_audit:actions"]&modifiedSince=T` — the same datastore the dedicated `audit.getLogs` endpoint used internally. Output filename `audit_logs.json` is preserved. The dedicated `/audit/logs` route was removed from open-pryv.io on 2026-06-15; **v0.6.0 is the minimum required version** for current open-pryv.io deployments (v0.5.0 and earlier produce empty `audit_logs.json` files).

### Restore

Restore is **CLI-only** + marked experimental — `audit`, `webhooks`, and `accesses` are deliberately not replayed on the target (system-generated or token-bearing). The library does not expose `Restore` programmatically; use `npm run restore <path>` from the CLI or read `src/restore.js` for the orchestration shape.

## (Experimental) Restore Streams and Events to another account

`npm start restore <path to backup dir>`

## Contribute

Prerequisites: Node v8+

Install dependencies: `npm install`

Run tests: `npm run test`

## License

MIT License as included
