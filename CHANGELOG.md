# Changelog

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
