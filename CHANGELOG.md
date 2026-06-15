# Changelog

## 0.6.0 — UNRELEASED — Library + CLI split, incremental backup, audit-as-events, browser-isomorphic core

Architectural rewrite around a programmatic library API (`require('@pryv/account-backup').Backup`) consuming pluggable adapters (`StorageWriter` + `StateStore`). The core resource-fetch modules are browser-isomorphic — `fetch` for HTTP, `StorageWriter.openWriteStream` for output. The CLI is preserved as a thin shim; behavior is byte-identical to 0.5.0 on a first run against a fresh backup directory. A sibling `pryv-account-backup-webapp` repository ships the browser-side adapter pair + sample UI.

**Upstream context driving v0.6.0:** the dedicated `/audit/logs` endpoint is being removed from open-pryv.io. v0.5.0 calls this endpoint and will fail once the removal lands. v0.6.0 fetches audit via `events.get?streams=[':_audit:accesses',':_audit:actions']` instead — audit is a regular `@pryv/datastore` mounted at `:_audit:*` on every Pryv core. This route is forward-compatible with the removal AND supports `modifiedSince`, which the dedicated endpoint does not.

### Added

- **`Backup` class + adapter interfaces** — new `src/lib/` package exporting `Backup`, `StorageWriter`, `StateStore`, `NodeFsStorageWriter`, `FolderStateStore`. The CLI now constructs these adapters internally; the public `require('@pryv/account-backup').start(params, cb)` callback API is unchanged.
- **Browser-isomorphic resource fetchers** — `api-resources`, `events-chunked`, `audit-as-events`, `accesses-history` now use global `fetch` (Node 18+ / every modern browser) for HTTP and `StorageWriter.openWriteStream` for output, with **zero** Node-only imports reaching the runtime path. esbuild bundles all four modules for the browser in ~12 KB. The Node-only resource fetchers (`attachments`, `hf-data`, `webhooks-export`, `manifest`) stay CLI-only — the v0.6.0 webapp sample does not expose attachments / HFS / webhooks fetches.
- **Incremental backup via `events.get?modifiedSince=T`** — when a `FolderStateStore` (or any `StateStore`) reports a `lastRunAt` from a prior successful run, the events fetch switches to a single incremental round-trip producing `events-incremental-<RUN-TS>.json` instead of the monthly chunked fetch. Deletions are included via `includeDeletions=true`. First-run behavior (chunked monthly `events-YYYY-MM.json`) is preserved.
- **Audit fetched via the standard events API on `:_audit:*` streams** — audit is registered as a regular `@pryv/datastore` on every Pryv core; querying `events.get?streams=[':_audit:accesses',':_audit:actions']&modifiedSince=T` reaches the same data the dedicated `audit.getLogs` endpoint serves, but with `modifiedSince` support for free. The output filename `audit_logs.json` is preserved so any consumer that keyed on it continues to work.
- **State persistence** — successful runs write `lastRunAt`, `events.lastModifiedSince`, `audit.lastModifiedSince`, plus tool + format version to a `.state.json` sentinel in the backup directory. Used to drive the next run's incremental thresholds.
- **Adapter contract tests `[PAAB]`** + **incremental + audit-as-events tests `[PAIB]` / `[PAAU]`** + **isomorphism contract tests `[PALI]`** + **hf-data regression test `[PAHF]`** — 43 new unit tests run without credentials.

### Fixed

- **HFS series data points missing from chunked-events backups** — `hf-data.js` inspected only the legacy `events.json` to discover `series:*` events; on a 0.5.0 backup (which writes chunked `events-YYYY-MM.json` instead), every series-event was silently skipped and the bundle produced zero data points despite the v0.3.0+ design saying it should carry them. Now iterates `BackupDirectory.listEventFiles()` so legacy and chunked file layouts both work. Regression test `[PAHF]` added.

### Changed

- **`scripts/start-backup.js`** unchanged — the CLI prompts and flow are identical to 0.5.0 from an operator's perspective. The orchestration delegates to the new `Backup` class internally.
- **`audit/logs?fromTime=…&toTime=…` dropped** from the metadata-fetch list — replaced by audit-as-events (see above). No behavior change on the output side; the audit_logs.json content is shape-compatible.
- **`https.get` / `fs.createWriteStream` removed from isomorphic modules** — replaced by global `fetch` + `StorageWriter.openWriteStream`. `Backup.run` constructs a `NodeFsStorageWriter` from the legacy `BackupDirectory` once and passes the writer to every per-method module; per-method modules no longer accept a `folder` shortcut.

### Compatibility

- A 0.5.0 backup directory restored against a 0.6.0+ CLI works: the orchestrator detects the missing `.state.json` and falls back to the initial chunked-fetch path. Re-running on top of a 0.5.0 backup directory adds the state file and switches to incremental on subsequent runs.
- The audit_logs.json filename + content shape are preserved; downstream consumers that keyed on the v0.4.0/0.5.0 file layout do not need to change.
- The CLI's `require('@pryv/account-backup').start(params, callback)` API is preserved verbatim.

### Known gaps still open after this release

- Same as 0.5.0 — jurisdiction-per-host inference for CMC counterparties is implementer-side; the backup bundle carries `profile.mfa.recoveryCodes` and must be treated as a password-reset-equivalent secret.

## 0.5.0 — 2026-06-13 — Chunked events + access-history completeness (DSAR)

Three DSAR-completeness items in a single release:

- **Chunked events fetch** — closes the last completeness gap noted in 0.3.0's "Known gaps" section: the single-shot `events?fromTime=…&toTime=…` round-trip is replaced with monthly time-range chunks so multi-GB subjects (long-running research participants, fitness-tracker subjects with years of high-frequency series, etc.) don't time out at the API gateway or OOM the caller's environment.
- **`accesses-all.json` (deletions + expired)** — the disclosure history now covers revoked and expired access tokens, which is what GDPR Art.15(1)(c) (recipients), Art.15(1)(a) (purposes of processing — consent-state-at-time-of-access provenance) and CCPA §1798.110 actually require. The current snapshot (`accesses.json`) is still written as before, so anything that currently keys on `accessId` keeps working.
- **Per-access version history (opt-in)** — `accesses-history/<accessId>.json` per access, fetched via `GET /accesses/<id>?includeHistory=true`. Off by default (O(N) calls); the CLI prompts at startup.

### Added

- **Chunked events fetch.** New module `src/methods/events-chunked.js` probes the subject's earliest and latest event time with two `limit=1` calls (sortAscending=true for the floor, default desc for the ceiling), then iterates monthly UTC-aligned windows. Each window writes its own file `events-YYYY-MM.json` carrying the standard API response shape `{ events: [...], meta: {...} }`. Default chunk size is 1 month; the CLI prompts for an override.
- **`accesses-all.json`** — second fetch of `GET /accesses?includeDeletions=true&includeExpired=true` runs alongside the standard current-snapshot `accesses.json`. The response shape mirrors `accesses.json` and adds an `accessDeletions` array with all soft-deleted (revoked) access rows. Useful when an Art.15 / Art.20 / §1798.110 disclosure needs the full sharing-history view, not just the live-tokens snapshot. (CMC counterparty metadata — `clientData.cmc.counterparty` + `clientData.cmc.apiEndpoint` — was already in `accesses.json` today; the API exposes the full `clientData` field verbatim, so no extra fetch is needed for cross-border narrative.)
- **`accesses-history/<accessId>.json`** — per-access version-history files, opt-in via a new CLI prompt ("Also fetch per-access version history?"). Each file carries `{ access, history: [...], current }` per the `accesses.getOne?includeHistory=true` response shape. Off by default because it's O(N) in the access count; a typical subject has ≤20 accesses, but a long-running deployment may have hundreds. Discharged what was listed as the "Per-access version history" gap.
- **`backup-directory` chunk helpers** — `BackupDirectory#hasEventsData()` returns true when either the legacy `events.json` or any `events-YYYY-MM.json` is present; `BackupDirectory#listEventFiles()` returns all event-data files sorted (legacy first, then chunks). Used by both the backup skip-check and the restore-side concatenation.
- **`BackupDirectory#accessesAllFile`** alongside `accessesFile`; **`BackupDirectory#accessesHistoryDir`** for the per-access version-history directory.
- **`apiResources.toJSONFile`** accepts an optional `filename` override (used by the access-history walker to produce `<accessId>.json` files without leaking the `accesses_…` prefix the resource-derived naming would otherwise create).
- **`[PACE]` + `[PAVH]` test suites** (`test/unit/events-chunked.test.js`) — 12 `[PACE]` tests covering monthly window math (year-boundary crossing, `chunkMonths>1` quarterly chunks, `from==to` instant subject, first/last-window clipping), `formatLabel` zero-padding, and chunk-file discovery, plus 2 `[PAVH]` tests covering the `accesses-all` file path and the `accesses-history` directory path. Run without credentials.

### Changed

- **Restore-side `restoreEvents`** now scans for both legacy `events.json` and any `events-YYYY-MM.json` chunks, concatenates the `events` arrays in sorted order, and buckets into standard / with-attachments / series as before. Backups produced by 0.4.0 and earlier still restore cleanly.
- **CLI `scripts/start-backup.js`** prompts for the events chunk size (default 1 month). The "events already exist" overwrite check now keys on `hasEventsData()` instead of the bare `events.json` path, and deletes all event-data files (legacy + chunks) on full restart.
- **CLI `scripts/start-restore.js`** accepts either a directory carrying `events.json` (older backups) or any `events-YYYY-MM.json` (0.5.0+) as a valid backup source.

### Compatibility

- Backups produced by 0.4.0 and earlier (`events.json` single-file) restore against 0.5.0 with no migration step.
- Manifests produced by 0.5.0 hash each chunk file independently; the integrity verification flow is unchanged (`manifest.verify(rootDir, cb)`).
- `audit/logs?fromTime=…&toTime=…` remains a single-shot fetch in this release — chunking the audit log is a separate concern (the audit row volume is typically orders of magnitude smaller than user events).

### Known gaps still open after this release

- **Jurisdiction inference per counterparty host** — `clientData.cmc.counterparty.host` carries the federation hostname but jurisdiction-per-host is the implementer's responsibility (no host-to-country registry in the API).

### Operator security note

The backup bundle includes `profile_private.json`, which carries `profile.mfa = { content, recoveryCodes }` verbatim. The 10 recovery codes can bypass the SMS challenge to deactivate MFA, and `content` may carry the subject's phone number. **Treat the backup as a secret on par with a password-reset link** — transport over a secure channel, document destruction policy, and consider rotating recovery codes (re-run MFA activate-confirm on the source account) after the disclosure is complete. The 0.4.0 → 0.5.0 transition does not change this behavior; the note is added here because the symmetry audit re-verified that this is by-design (the subject IS entitled to their full MFA state).

## 0.4.0 — 2026-05-22 — Dependency upgrade + multi-attachment restore (Plan 72 follow-up)

Squashed into the same Plan 72 Phase C session: comprehensive dependency upgrade to clear the GitHub Dependabot queue and lift the `pryv@2.3.3` single-attachment limitation that 0.3.0's restore-side notes documented as a known gap.

### Security / dependency upgrade

- **0 npm-audit vulnerabilities** (was: 1 critical / 4 high / 4 moderate / 1 low → 0 across all severities).
- `pryv` 2.3.3 → 3.4.1 (lib-js v3 mainline). API surface used by this tool is unchanged for the common paths (`Service.login`, `Connection.api`, `addPointsToHFEvent`, `createEventWithFile`) and gains `createEventWithFormData` (Node 18+ FormData) which enables the multi-attachment restore below.
- `async` 0.9.x → 3.x. `series` / `mapSeries` / `mapLimit` / `eachSeries` signatures are backward-compatible for this tool's usage; no callsite changes needed.
- `read` 1.x → 5.x. v5 returns a Promise; the two CLI entrypoints (`scripts/start-{backup,restore}.js`) wrap the new shape in a `readP(opts, cb)` adapter so the existing `async.series` chains stay intact.
- `mocha` 10 → 11, `should` 11 → 13, `superagent` (dev) 6 → 10. Test framework only.
- `JSONStream` ^1.3.4 → ^1.3.5 (in-range patch). Used by `attachments.js` event-file streaming.
- `npm overrides` added for `diff: ^9.0.0` and `serialize-javascript: ^7.0.5` to lift the last 3 transitive vulnerabilities that `mocha@11.7.6` still pulls in (matches the open-pryv.io Plan 56 pattern).

### Removed dependencies (dead code)

- `lodash` — imported in `main.js` but never used.
- `cuid` — imported in `restore.js` but only referenced inside commented-out code.
- `mkdirp` — replaced by native `fs.mkdir({recursive:true})` (Node 10+). `mkdirp@3` went ESM-only; the rewrite is simpler than fighting CJS/ESM interop.
- `nconf` + `winston` — only used by `src/utils/config.js`, which was itself dead (no callers in `src/` or `scripts/`). File deleted. `scripts/kickstart.js` previously imported it for `dev-config.json` reading; inlined a 3-line `JSON.parse(fs.readFileSync(...))` instead.

### Restore-side change — multi-attachment events now round-trip

- `uploadEventsWithAttachments` keeps the single-attachment path on `createEventWithFile` (simplest case, no FormData ceremony). When `attachments.length > 1`, builds a Node `FormData` with one `file` part per attachment (each via `fs.openAsBlob` / `new Blob([buf])`) and posts via `connection.createEventWithFormData(event, formData)`. The 0.3.0 "WARN: skipped attachment[1+]" log is gone — all attachments now round-trip.
- One known caveat persists: `audit_logs`, `webhooks`, and `accesses` are still NOT restored (each requires non-trivial machinery; documented in the "Known gaps" section below).

### Other

- `engines.node: ">=18"` added to package.json (`pryv@3` + native FormData / fs.openAsBlob need Node 18+).
- The two pre-existing unit tests `test/unit/{backup-directory,attachments,api-resources}.test.js` need a real Pryv account via `test/helpers/testuser.js` to run (pre-existing — not introduced by this upgrade). Only `test/unit/manifest.test.js` runs without credentials; all 3 of its tests still pass.

## 0.3.0 — 2026-05-22 — DSAR coverage completeness (Plan 72 Phase C)

`@pryv/account-backup` is the end-user-facing tool implementers point subjects at when answering a GDPR Art.15 (right of access) or CCPA §1798.110 request. Through v0.2.3 the dump was missing several whole resource families even when the operator had them enabled — the implementer was returning an incomplete portable record without knowing it. This release closes those gaps and adds an integrity manifest so a third party can prove the dump wasn't tampered with mid-flight.

### Added (backup side)

- **Audit log export** (`audit_logs.json`) — fetched from `GET /audit/logs?fromTime=…&toTime=…` over the full subject window. Required by GDPR Art.15 / CCPA §1798.110 / PIPEDA Principle 4.9: the audit trail is part of "personal data" when it contains the subject's identifiers.
- **High-frequency series data points** (`hf-data/<eventId>.json`) — for every event whose `type` starts with `series:`, the actual data points are now fetched via `GET /events/<id>/series` and written one file per series event. Previously, only the series event "container" was backed up, so the bulk of an HFS user's data was silently missing.
- **Webhooks export** (`webhooks.json`) — every access's `/webhooks` is queried with that access's own token and the results aggregated, keyed by `accessId`. Previously, webhooks weren't fetched at all, so any subject who had configured outbound notifications had no record of them in the dump.
- **Per-file sha256 integrity manifest** (`manifest.json`) — a final pass walks the backup directory, computes sha256 of every regular file, and writes `{ algorithm, version, generated_at, file_count, files: { <relpath>: <hex> } }`. The new `manifest.verify(rootDir, cb)` helper re-hashes and reports any mismatch / missing / extra files. Format is per-file rather than tarball-wide so a restore preflight or third-party auditor can pinpoint exactly which file was corrupted.

### Added (restore side — Phase C.4 partial)

- **Series event containers + HFS data points are now restored.** The pre-0.3.0 restore filtered `series:*` events into a bucket and silently dropped them. Now the container event is created via `events.create` (the lib's batch API call), then for each successfully created event the matching `hf-data/<oldId>.json` is read and its `fields`+`points` are posted via `connection.addPointsToHFEvent(newId, fields, points)`. Old-id → new-id mapping is preserved through the call by tagging each batch entry; per-event HFS errors are logged and skipped rather than aborting the whole restore.
- Restore output now includes `res_series_events.log` alongside the existing `res_events.log` / `res_attachments.log` so a third party can audit what the restore actually shipped.

### Removed

- **`followed-slices` fetch** — the resource is a v1-only legacy and returns 404 on every v2 deployment. The previous `null`-on-disk file was misleading.

### Changed

- Backup directory now creates `hf-data/` (alongside `attachments/` and `app_profiles/`) when series events are present.
- Acceptance test `[SBTC]` updated to assert the new artefacts.

### Known gaps still open after this release (superseded by 0.4.0 for the multi-attachment item)

- **Restore is still marked experimental.** What does NOT round-trip yet (post-0.4.0):
  - **Audit logs.** The audit trail is system-generated and tied to actual API calls made against the source; injecting it into a destination would produce false audit history. Restoring the trail isn't a meaningful operation; the backup is the historical record.
  - **Webhooks.** Webhooks are keyed by `accessId`. A fresh restore destination has new access IDs (and new tokens), so the source-side `accessId` references in `webhooks.json` would not resolve. Restoring webhooks would require first restoring accesses (with new server-minted tokens) and then re-binding `webhooks.json` entries to the new IDs — a coordinated multi-step flow that's out of scope here.
  - **Accesses themselves.** Same reason — server-minted tokens can't be replayed.
  - ~~Multi-attachment events~~ → fixed in 0.4.0 via `pryv@3` `createEventWithFormData`.
- **Access version history** — `/accesses?includeDeletions=true` would surface deleted accesses; not yet wired in on the backup side either.
- **CMC counterparty metadata** (Plan 71 Q10) — separate Phase 2 work.
