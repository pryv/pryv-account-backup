# `sync-state.json` — portable incremental-backup state

The portable companion file produced at the end of every successful
backup run since v0.7.0. Both flavors include it in the run output:

- **CLI** — written to `<backupDir>/sync-state.json` (visible, alongside
  the chunked events / accesses / webhooks output).
- **Webapp** — embedded inside the final downloadable ZIP at the bundle root.

The file's job is **cross-session incremental**: the subject keeps it
alongside the backup; on the next run they re-supply it (CLI auto-reads
the backup directory; the webapp offers an upload picker on the login
screen). The library hydrates the `StateStore` from it, and the next run
issues `events?modifiedSince=…` / `audit-as-events?modifiedSince=…`
instead of a full chunked refetch.

## Schema (formatVersion 1)

```json
{
  "format": "pryv-account-backup-sync-state",
  "formatVersion": 1,
  "toolVersion": "0.7.0",
  "createdAt": "2026-06-15T16:43:27.000Z",
  "kv": {
    "lastRunAt": 1781542207,
    "events.lastModifiedSince": 1781542207,
    "audit.lastModifiedSince": 1781542207,
    "formatVersion": 1,
    "toolVersion": "0.7.0"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `format` | string (literal) | Always `"pryv-account-backup-sync-state"`. Used by `StateStore.import()` to refuse unrelated JSON files. |
| `formatVersion` | integer | Schema version; current value is `1`. `import()` rejects unsupported versions with a clear error message. |
| `toolVersion` | string (semver) | Version of `@pryv/account-backup` that produced the file. Diagnostic only — not enforced on import. |
| `createdAt` | string (ISO-8601 UTC) | Wall-clock at export-time. Diagnostic only. |
| `kv.lastRunAt` | integer (UTC seconds) | Start timestamp of the run that produced this file. Read on the next run to gate "is there prior state?". |
| `kv.events.lastModifiedSince` | integer (UTC seconds) | The threshold for the next `events.get?modifiedSince=…` round-trip. Conservatively set to `lastRunAt` (events modified strictly *after* this point flow over the wire next time; events modified *during* the run get a small overlap on the next run, which is harmless — duplicates write identically and re-imports are idempotent at the event-id key). |
| `kv.audit.lastModifiedSince` | integer (UTC seconds) | Same semantics as the events threshold, applied to the `:_audit:*` streams fetch. |
| `kv.formatVersion` / `kv.toolVersion` | int / string | Mirror of the envelope fields; recorded inside `kv` so they survive an export/import round-trip and tools that inspect only the kv tree still see them. |

## What is NOT in the export

- **Refs.** Per-category work refs (`attachment`, `series-event`, `webhook`)
  discovered during a run are kept in the operational store but **dropped
  from the portable export**. Each run re-discovers refs from the events
  + accesses streams; persisting completed refs across runs adds no value,
  and persisting pending refs across runs invites stale-token / phantom
  bugs (a webhook ref whose access has since been revoked is better
  re-discovered than re-tried).

- **Tokens / credentials.** The file carries no auth material. The
  subject must re-authenticate on every run (CLI prompt; webapp login
  form).

- **Resource content.** This file is metadata about the backup; the
  backup data itself lives in the sibling JSON / binary / ZIP files.

## Lifecycle

```
run N:
  start
    └── state.export()                        ⤴
                                              │
    fetch + drain (refs in operational store) │
                                              │
  end                                         │
    └── writer.openWriteStream('sync-state.json').write(JSON.stringify(snapshot))
                                              │
                  ┌───────────────────────────┘
                  ▼
              keep alongside ZIPs / on disk

run N+1:
  CLI:    FolderStateStore auto-reads <baseDir>/.sync-state.json
          (or migrates from pre-v0.7.0 <baseDir>/.state.json)
  Webapp: subject uploads sync-state.json on the login screen
          → LocalStorageStateStore.import(file)
  Then: orchestrator reads kv.lastRunAt + thresholds → incremental fetch
```

## CLI: hidden operational vs. visible portable

The CLI ships **two** sync-state files in the backup directory:

- `.sync-state.json` (hidden; the operational store) — kv state +
  per-category refs. Refs accumulate during a run and are pruned at
  export-time. Survives interrupted runs so a re-run can resume.
- `sync-state.json` (visible; the portable artefact) — kv state only,
  written via the `StorageWriter` at the end of the run. The subject's
  copy if they want to move the disclosure across machines / re-run
  from a different baseDir.

Both files share the same `formatVersion` and are mutually consistent
after a clean run.

## Webapp: localStorage operational + ZIP-shipped portable

- **Operational store:** `localStorage["pryv-account-backup:state:<apiEndpoint>"]`
  carries the same `{ kv, refs }` shape (same schema; refs survive
  tab-close).
- **Portable export:** `sync-state.json` embedded inside the final ZIP.
  When the subject re-uploads it on the next visit, the pre-login UI
  imports the kv state and the next run goes incremental.

## Versioning policy

- Backward-compatible changes (new optional `kv` keys, new envelope
  metadata fields) keep `formatVersion: 1`.
- Schema breaks (renaming a `kv` key, changing field semantics) bump
  `formatVersion`. `StateStore.import(data)` will reject unsupported
  versions with `StateStore.import: unsupported formatVersion X
  (expected Y)`.
- The `format` literal is reserved and will not change between versions
  — it stays `"pryv-account-backup-sync-state"` so unrelated JSON files
  (operator-side backup snapshots, third-party tools) are rejected
  cleanly.
