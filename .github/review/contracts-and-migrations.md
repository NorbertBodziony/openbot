---
include:
  - "src/backend/openbot-database-schema.ts"
  - "src/backend/openbot-database.ts"
  - "src/backend/database/**"
  - "apps/auth-api/migrations/**"
  - "packages/contracts/**"
---

## Contracts and migrations review

These files carry data the repository cannot re-derive: the user's SQLite database
(`src/backend/openbot-database-schema.ts` holds every released schema and migration,
`openbot-database.ts` and the controllers under `src/backend/database/` are the boundary), the
account service's D1 database, and every wire protocol already in the field. Findings here are P0 or
P1 by default.

Report a finding when the diff:

- Edits or deletes a migration that may have shipped, including the frozen version 8 baseline.
  Migrations are append-only and contiguous.
- Splits a schema change from its `schema_migrations` marker, or leaves either outside the same
  transaction. Also flag a missing rollback path, foreign-key enforcement not restored in `finally`,
  or integrity checks skipped before startup continues.
- Adds a migration without data-preservation fixtures for every affected released schema, or without
  failure, rollback, retry, downgrade, missing-version, foreign-key, and integrity coverage.
- Adds an automatic full-database backup before a migration. Conversation history lives in SQLite, so
  the time and disk cost is unbounded; the migration itself has to be safe.
- Changes a released Team API protocol under `packages/contracts/src/team-protocol` — a required
  field, a removed field, or a changed meaning. That needs a new version, not an edit.
- Removes a registered adapter, or serializes current IPC types directly across the Team API
  boundary.
- Uses the application SemVer as a wire protocol version.
- Makes a malformed known payload anything other than a fail-closed `protocol_error`, or fails on an
  unknown optional event instead of ignoring it.
- Puts a type in `packages/contracts` that does not cross a process or application boundary.
- Adds a D1 migration under `apps/auth-api/migrations/` that the currently live Worker would not
  tolerate. CI applies D1 migrations **before** deploying the new Worker, so a migration that is not
  backward compatible needs a test proving the old Worker survives it, or a two-step release.

Do **not** report:

- The existence of old adapters. Released adapters are permanent by design; age, release count, and
  SemVer distance are not reasons to remove one.
- Duplication between a frozen adapter and the current one. Frozen copies are deliberately frozen.
- A capability used for additive, optional behaviour where a missing capability disables only the
  related feature. That is the intended mechanism.
