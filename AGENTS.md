# Agent orientation — `pryv-account-backup`

This repo is the **library + CLI** for end-user-driven Pryv account backup. The sample webapp [`pryv-account-backup-webapp`](https://github.com/pryv/pryv-account-backup-webapp) consumes this repo via a `github:` URL.

## What this is

A single tool with two consumption modes:

- **CLI** — `npm install && npm start` (the historical entry point; behavior is preserved through every release).
- **Library** — `require('@pryv/account-backup')` exposes `Backup` + adapter interfaces (`StorageWriter`, `StateStore`) + CLI implementations (`NodeFsStorageWriter`, `FolderStateStore`). Seven per-method modules are **browser-isomorphic** since v0.7.0 (`api-resources`, `events-chunked`, `audit-as-events`, `accesses-history`, `attachments`, `hf-data`, `webhooks-export`); the only Node-only module is `manifest` (sha256 stays CLI-only).

The tool produces a portable account dump suitable for GDPR Art.15 / Art.20, CCPA §1798.110 / §1798.115, PIPEDA Principle 4.9, Swiss nLPD Art.25, HIPAA-privacy §164.524 disclosure requests.

## What's in a backup bundle

Per-user run output (CLI, in a folder; webapp, across N ZIP files):

| File | Source | Notes |
|---|---|---|
| `account.json` | `GET /account` | account info, language, system-streams account-tree |
| `streams.json` | `GET /streams` (or `?state=all` with `--includeTrashed`) | stream hierarchy |
| `accesses.json` | `GET /accesses` | current accesses |
| `accesses-all.json` | `GET /accesses?includeDeletions=true&includeExpired=true` | full disclosure-history view |
| `profile_private.json` / `profile_public.json` | `GET /profile/{private,public}` | includes `profile.mfa.{content,recoveryCodes}` when MFA enabled |
| `app_profiles/profile_app_<accessId>.json` | per-app `GET /profile/app` with each app token | |
| `audit_logs.json` | **`GET /events?streams=[':_audit:accesses',':_audit:actions']&modifiedSince=T`** (v0.6.0+) — was `/audit/logs` in v0.4.0–v0.5.0 | audit is a regular `@pryv/datastore` mounted at `:_audit:*` on every Pryv core; the dedicated `/audit/logs` route was **removed** from open-pryv.io on 2026-06-15 (commit `19d1c11f`), so v0.5.0 and earlier are now production-broken for the audit-log section against any deployment running that build |
| `events-YYYY-MM.json` | `GET /events?fromTime=…&toTime=…` per monthly chunk (initial run) | preserves the v0.5.0 chunking story for first runs |
| `events-incremental-<TS>.json` | `GET /events?modifiedSince=T&includeDeletions=true` (subsequent runs) | only events with `modified > T`; deletions included |
| `accesses-history/<accessId>.json` | per-access `GET /accesses/<id>?includeHistory=true` (opt-in) | O(N) calls; opt-in via CLI prompt or `params.includeAccessHistory` |
| `attachments/<eventId>_<fileName>` | per-attachment `GET /events/<id>/<attId>?readToken=…` (opt-in) | streamed binary; both CLI + webapp |
| `hf-data/<eventId>.json` | per `series:*` event `GET /events/<id>/series` (opt-in) | HFS data points; both CLI + webapp |
| `webhooks.json` | per-access `GET /webhooks` (opt-in) | aggregated by `accessId`; both CLI + webapp |
| `manifest.json` | sha256 per file (**CLI only**) | tamper-evidence; webapp does not generate this |
| `sync-state.json` | portable kv snapshot of `lastRunAt` + per-resource `lastModifiedSince` + tool/format version | both CLI + webapp (v0.7.0+); subject downloads + re-uploads to drive cross-session incremental in the browser |
| `.sync-state.json` (CLI, hidden) / `localStorage` (webapp) | operational store: kv state + per-category work refs (`attachment`, `series-event`, `webhook`) discovered during one run | refs are pruned at run-end; only kv goes into the portable `sync-state.json` |

## Architecture

```
src/lib/
├── Backup.js                  ← orchestrator (coordinates per-method modules; wires onParsed
│                                tee → state.pushRef; drains refs through per-category drainers)
├── index.js                   ← library entry: Backup + adapters
└── adapters/
    ├── StorageWriter.js       ← abstract: openWriteStream / exists / finalizeBatch
    ├── StateStore.js          ← abstract: kv (get / set / getAll / flush)
    │                            + refs (pushRef / listPending / markDone / clearCategory)
    │                            + portable (export / import)
    ├── NodeFsStorageWriter.js ← writes to disk; back-compat with BackupDirectory
    └── FolderStateStore.js    ← .sync-state.json sentinel in baseDir; auto-migrates from .state.json

src/methods/                   ← per-resource fetchers (all browser-isomorphic except manifest)
├── api-resources.js           ← fetch + writer; opt-in onParsed(doc) tee
├── events-chunked.js          ← chunked initial / single incremental; onEvents(events[]) lift
├── audit-as-events.js         ← :_audit:* streams via events.get
├── accesses-history.js        ← per-access version history (in-memory array)
├── attachments.js             ← drains 'attachment' refs; binary stream pipe
├── hf-data.js                 ← drains 'series-event' refs; data-points fetch
├── webhooks-export.js         ← drains 'webhook' refs; per-access /webhooks
└── manifest.js                ← Node-only (sha256 tamper-evidence)

scripts/
├── start-backup.js            ← CLI entry (interactive prompts)
└── start-restore.js           ← CLI restore (experimental, deliberately limited)

src/restore.js                 ← restore-side logic (CLI only; library does NOT export restore)
```

## Ref-tracking flow (v0.7.0+)

```
            ┌──────────────────────────────────────────────┐
fetch step  │  api-resources.toJSONFile({ onParsed: ... }) │
            │  events-chunked.download({ onEvents: ... })  │
            └──────────────┬───────────────────────────────┘
                           │  parsed doc
                           ▼
                ┌──────────────────────┐
   orchestrator│ state.pushRef(cat,r)  │
                └──────────┬───────────┘
                           │
                           ▼
              .sync-state.json (Node) / localStorage (browser)
                           │
                           │  state.listPending(cat) →
                           ▼
                ┌──────────────────────┐
drain step      │ attachments.download │  fetch + write + markDone
                │   / hf-data.download │
                │ / webhooks.download  │
                └──────────────────────┘
```

## Phases I should NOT cross without operator approval

- **Pre-existing v0.5.0 file layout breaks.** Many third-party consumers key on `audit_logs.json`, `events-YYYY-MM.json`, etc. New resources land in NEW files; do not rename existing ones.
- **Restore-side reproducibility for audit / webhooks / accesses.** These are **deliberately not replayed** on restore — they're system-generated or carry server-minted tokens. The webapp does not expose restore at all; the CLI restore is marked experimental.
- **Adding a server-side endpoint to open-pryv.io.** This tool calls the public API; it is not a core feature. The historical alternative (an `account.export` core endpoint) was explicitly rejected in favor of the library + sample webapp architecture.
- **Removing the `manifest.json` from CLI output.** The sha256 manifest is the third-party-auditor tamper-evidence story for the CLI. The webapp's lack of a manifest is a deliberate trade-off documented in `pryv-account-backup-webapp/README.md`.
- **Bumping the `pryv` lib-js major version.** The library calls `Service.login`, `Connection.api`, `addPointsToHFEvent`, `createEventWithFile`, `createEventWithFormData`. A major bump on lib-js needs a careful read of every consumer + the deps section in `package.json`.

## Build + test cadence

- `npm install && npm test` runs the credential-free unit suite (Mocha). The CI is currently dormant (`.travis.yml` is stale; no GitHub Actions yet). Add or update CI as a separate concern when needed.
- Integration tests (`test/unit/api-resources.test.js`, `test/unit/attachments.test.js`, `test/unit/backup-directory.test.js`) require a Pryv account configured in `test/helpers/testuser.js` — they are not currently part of `npm test` because they need credentials.
- `npx mocha test/unit/events-chunked.test.js test/unit/manifest.test.js test/unit/adapters.test.js test/unit/incremental.test.js test/unit/isomorphism.test.js` runs the v0.5.0/v0.6.0 unit suites that ship without credentials.

## Distribution

- License: BSD-3-Clause.
- Released as git tags; **not on the npm registry** (and not planned to be). Release flow: merge PR → tag `vX.Y.Z` → push tag. Consumers (the sample webapp, custom forks) pin via `github:pryv/pryv-account-backup#<tag-or-branch>` in their `package.json`.

## Operator security note

`profile_private.json` carries `profile.mfa = { content, recoveryCodes }` verbatim when MFA is enabled. The 10 recovery codes can bypass the SMS challenge to deactivate MFA, and `content` may carry the subject's phone number. **Treat the backup as a secret on par with a password-reset link** — transport over a secure channel, document destruction policy, and consider rotating recovery codes after the disclosure. This applies to BOTH CLI and webapp output.

## Companion repos

- [`pryv-account-backup-webapp`](https://github.com/pryv/pryv-account-backup-webapp) — sample browser-based UI consuming this library.
- [`lib-js`](https://github.com/pryv/lib-js) (npm `pryv`) — the Pryv API client; provides `Service.login` + `Connection`.
- [`open-pryv.io`](https://github.com/pryv/open-pryv.io) — the Pryv API server. The complementary operator-side `bin/backup.js` lives there (raw-row disaster-recovery snapshot; not subject-portable).

## Compliance posture

The bundle this tool produces is the read-side primitive for the DSAR / portability row families in the Pryv compliance matrix (`gdpr.Art.15`, `gdpr.Art.20`, `ccpa.1798.110`, `pipeda.Principle.4.9`, `swiss-nlpd.Art.25`, `hipaa-privacy.164.524`). Don't ship changes that weaken those claims without coordinating with the matrix narrative.
