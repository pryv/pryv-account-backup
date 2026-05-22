# Changelog

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

### Known gaps still open after this release

- **Restore is still marked experimental.** What does NOT round-trip yet:
  - **Multi-attachment events.** The bundled `pryv@2.3.3` Connection exposes `createEventWithFile` (single-attachment) only. The restore now logs a per-event warning naming every skipped attachment so a restore-side auditor can reconcile against the source, but the secondary files are not re-uploaded. Lifting this needs `pryv@3+` (multi-attachment via `addFileToEvent`) — deferred.
  - **Audit logs.** The audit trail is system-generated and tied to actual API calls made against the source; injecting it into a destination would produce false audit history. Restoring the trail isn't a meaningful operation; the backup is the historical record.
  - **Webhooks.** Webhooks are keyed by `accessId`. A fresh restore destination has new access IDs (and new tokens), so the source-side `accessId` references in `webhooks.json` would not resolve. Restoring webhooks would require first restoring accesses (with new server-minted tokens) and then re-binding `webhooks.json` entries to the new IDs — a coordinated multi-step flow that's out of scope here.
  - **Accesses themselves.** Same reason — server-minted tokens can't be replayed.
- **Access version history** — `/accesses?includeDeletions=true` would surface deleted accesses; not yet wired in on the backup side either.
- **CMC counterparty metadata** (Plan 71 Q10) — separate Phase 2 work.
