---
name: release-upgrade-safety
description: Audit a pending OpenBot release for upgrade and data-loss hazards before the version is bumped or tagged. Use when asked to cut a release, create or bump a version, prepare a tag, or check whether a change is safe to ship to installed users.
---

# Release upgrade safety

Every hazard here is one an installed user pays for and you cannot take back. `openbot.db` is
migrated in place with no backup, two dozen files under `userData` are rewritten by whichever build
opens them last, a released Team API adapter is spoken by peers you will never update, and the
account Worker's D1 migrations are applied before the Worker that needs them. A build that ships
past one of these does not fail on your machine; it fails on someone else's, once, permanently.

Audit the diff since the last released tag against the seven gates below, then report a verdict.
This runs *before* `docs/RELEASING.md`, which stays authoritative for the publish itself.

## What this skill does and does not do

- It audits. It does not run `bun run release:patch`, commit a version bump, or push a tag unless
  you are separately asked to.
- It never runs `bun run check`, `check:desktop`, `test`, or `build-storybook` — each takes minutes,
  CI owns them, and the desktop suite flakes under load, so a red result would tell you nothing.
  Run the narrowest test file named by a gate, then `bun run lint` and `bun run typecheck`.
- **If gate C or D fired, add `bun run mobile:typecheck`.** `bun run typecheck` is `typecheck:*` and
  the mobile script is named `mobile:typecheck`, so the aggregate misses it — and `apps/mobile`
  depends on `@openbot/contracts`, which is exactly what those two gates change. A contract export
  change passes the aggregate and still breaks the mobile app.
- It never runs `bun run dev:seed` or `dev:reset` — both destroy the developer's own profile — and
  never `pkill -f`, which kills other sessions' work mid-write.

## Step 1 — establish the range

```bash
git tag --list 'v*' --sort=-v:refname | head -1
git diff --stat <tag>..HEAD
```

The audit is over that commit range, not over the working tree: an uncommitted edit is not what
ships, and a hazard three commits back is. State the tag and the changed-file count up front, and
run every gate's `git diff` over that same range.

## Step 2 — the seven gates

Each gate is triggered by a path appearing in the diff. Work through all seven. A gate no path
triggered is reported as **not triggered** — never dropped silently, because "I did not look" and
"I looked and it was clean" are different verdicts and only one of them is a release gate.

`references/surfaces.md` holds the exhaustive path inventory. Load it when a gate fires and you
need the exact file, not before.

### A. SQLite schema — `src/backend/openbot-database-schema.ts`

Triggered by any change to that file or to `src/backend/database/`.

- New entries in `MIGRATIONS` must **continue contiguously from the last version at the release
  tag**. Read that number, never remember it:

  ```bash
  git show <tag>:src/backend/openbot-database-schema.ts | grep -E 'version: [0-9]+' | tail -1
  ```

  A literal written into this file would go stale the first time a migration ships and would then
  reject the correct number. `validateMigrationRegistry` throws on a gap, so a skipped number is
  loud — but a *reused* one is a migration that never runs on any database that already applied it.
- **No shipped `migrateTo*` body may have changed**, including the frozen `migrateToBaselineV8`.
  Read every hunk of the diff, not the stat. A database that already applied version 12 will never
  apply it again, so an edit to it reaches new installs only and the two populations diverge.
- **If the migration executes DDL, `LATEST_SCHEMA_SQL` must be extended in the same change.**
  `createLatestDatabase` execs that SQL and then stamps every `MIGRATIONS` entry as applied
  *without running it*, so a DDL migration missing from it ships new installs a database without
  the column upgraded installs have. Today `LATEST_SCHEMA_SQL` is derived by `substituteOnce`,
  which replaces exactly one table in the v8 baseline (the v12 reactions table) and throws on zero
  or two matches. A second DDL migration must change that mechanism, not append to it.
- Data-preservation fixtures for every shipped source schema, plus failure, rollback, retry,
  downgrade, missing-version, foreign-key and integrity coverage, per `src/backend/AGENTS.md`.
- Confirm the downgrade guard still names the new `LATEST_SCHEMA_VERSION` — the test is
  "rejects a database created by a newer application" in `src/backend/openbot-database.test.ts`.

```bash
bun run test:desktop -- src/backend/openbot-database-schema-parity.test.ts
bun run test:desktop -- src/backend/openbot-database.test.ts
```

The parity test builds a database both ways and compares normalised `sqlite_master` and
`PRAGMA table_info`, so an unmirrored DDL migration is red rather than a support ticket. If it is
green and you added DDL, check that you actually added it to `MIGRATIONS`.

### B. On-disk state outside SQLite — `src/main/index.ts`, `src/backend/*-store.ts`

Triggered by a change to any file in the inventory in `references/surfaces.md`.

- **Did an on-disk filename constant change?** A rename is silent data loss: the old file is never
  found, never read, and never deleted. The new build starts from its defaults and the user's
  setup, servers or window state are simply gone.
- **Did a stored payload `version` bump?** Every shipped previous shape needs a read path. Three
  working precedents to copy, in descending order of care:
  - `src/main/remote-server-stored-shape.ts` — reads v1 and v2 as a re-tag of v3, preserves entries
    it cannot parse rather than dropping them, and **refuses an unknown version outright** so it
    never overwrites a file a newer build can still read.
  - `src/main/team-store.ts` — keeps `openbot-team-server-v1.json` and `-v2.json` on disk together,
    so a user who downgrades still finds their host.
  - `src/main/dynamic-island-preference-store.ts` — reads `version === 1` and `=== 2` into 3.
  - Known gap, re-check every release: `src/main/setup-store.ts` accepts only `version === 2` and
    falls back to defaults on anything else, silently. Bumping it to 3 without a read path re-runs
    setup for every installed user.
- **The permanent names are permanent.** The four legacy path prefixes in
  `src/backend/workspace-paths.ts`, `bots.json` (`LEGACY_AGENTS_STATE_FILE` in
  `src/backend/agent-store.ts`), `mailbox.json`, and the `legacy-import:bots:v1` command id are
  spellings a shipped release already wrote to the user's disk. A database restored from the user's
  own file copy never ran migration v13, so `bot-<uuid>` ids and `~/OpenBot/Bots` paths are still
  live values.
- **`legacy-backup-v1/` is not a general backup.** `DatabaseCore.backupLegacyFile` copies a single
  named file, once, with `COPYFILE_EXCL`, and it is used for the two legacy JSON imports only.
  Nothing else on disk is ever copied before being rewritten.
- **`safeStorage` files become undecryptable** if the macOS signing identity, team ID or `appId`
  changes: `openbot-central-auth-v1.bin` and the remote-desktop secret files are encrypted against
  the keychain entry those identify. Diff `electron-builder.yml` for `appId`, `ElectronTeamID`, and
  the `publish` block — this overlaps gate F on purpose, because one field breaks two things.

### C. Team API wire — `packages/contracts/src/team-protocol/`

Triggered by any change under that directory.

First derive the frozen set from the tag rather than hard-coding versions — a protocol released
since you last read this file is frozen too, and a hard-coded `v1 v2 v3` would never audit it:

```bash
FROZEN=$(git ls-tree --name-only <tag> packages/contracts/src/team-protocol/ \
  | grep -E '/v[0-9]+\.ts$')
git diff --stat --diff-filter=MDR <tag>..HEAD -- $FROZEN \
  packages/contracts/src/team-protocol/fixtures
```

**This must be empty.** `--diff-filter=MDR` is the point: a released codec or fixture that was
*modified, deleted or renamed* is a broken contract with every peer still running an older build,
and the fix is a new protocol version, never an edit. `R` is in that list deliberately — git
classifies a rename as `R` rather than `M`, so leaving it out lets a frozen fixture be renamed out
from under the check while the diff still reports clean.

An *added* fixture is additive and allowed. Read the additions separately with `--diff-filter=A`
and confirm each is a genuinely new case rather than the other half of a rename.

If the modified-or-deleted diff is non-empty, read every hunk before calling it a stop. A change
that provably cannot alter what any encoded payload means — an added `export` keyword, a comment —
is not a wire change. Anything that touches a key list, a validator, or a projected value is.

- Every shipped protocol is still registered, and the negotiation maximum only ever grows. Age and
  SemVer distance are not reasons to drop an adapter (`packages/contracts/AGENTS.md`).
- A new additive capability belongs in `current.ts`, never in a frozen codec.
- **Any new key needs a `current-agent-keys.ts` decision.** The failure is silent, not loud: the
  frozen codecs project through a key allowlist, an unmapped key is *dropped*, the encode then
  fails validation and returns `null`, and callers read `null` as "nothing to send". `tsc` stays
  green throughout.

```bash
bun run test:desktop -- packages/contracts/src/team-protocol/v1.test.ts
bun run test:desktop -- packages/contracts/src/team-protocol/v2.test.ts
bun run test:desktop -- packages/contracts/src/team-protocol/v3.test.ts
```

The full compatibility matrix — older client against new host, new client against older host,
matching versions, no shared protocol, capability omission, unknown optional events, malformed
known events — stays where it is, in `docs/RELEASING.md` preflight item 0. Point at it; do not
restate it.

### D. IPC channels — `packages/contracts/src/ipc-channels.ts`

Triggered by a change to the channel list **or to any of its mirrors** — `src/main/index.ts`,
`src/main/ipc/`, `src/preload/index.ts`, `src/renderer/src/preview/mock-openbot.ts`. Deleting a
handler or an `invoke` breaks a live channel without touching the list at all, and the coverage
test below is what catches it, so a gate that only watched the list would skip the one run that
would have found it.

Renderer and main ship in one binary, so a channel rename is **not** an upgrade hazard — nothing
older ever calls it. The hazard is drift between the list and its hand-written mirrors, which is a
runtime rejection in the build you are about to sign. Confirm all of them moved together, per the
table in `packages/contracts/AGENTS.md`: the `handleTrusted` registrations in `src/main/index.ts`
and `src/main/ipc/`, the `invoke` calls in `src/preload/index.ts`, and
`src/renderer/src/preview/mock-openbot.ts`, the second implementation Storybook and the preview run
against.

```bash
bun run test:desktop -- src/main/ipc-channel-coverage.test.ts
```

That test links main and preload. The mock is covered by `tsc` in both directions, so what is left
for you to judge is its *behaviour* — a mock method that satisfies the type by returning an empty
array is a story that silently shows nothing.

### E. Account Worker — `apps/auth-api/`

Triggered by **any** addition, modification, deletion or rename under `apps/auth-api/migrations/`,
or a change under `apps/auth-api/src/routes/` or `apps/auth-api/src/server/`:

```bash
git diff --stat --diff-filter=AMDR <tag>..HEAD -- apps/auth-api/migrations
```

Three separate hazards; check all three.

- **An already-applied migration was edited.** This is a stop, and it is the one that looks
  harmless. Wrangler records migrations by *name* and never replays a file it has already applied,
  so an edit leaves production on the old schema while every fresh database executes the new
  history. The two diverge permanently and nothing reports it. Same rule as `src/backend`: append a
  new migration, never edit a shipped one — for a different reason, since here it is the applied-name
  ledger rather than the absence of a backup.
- **The D1 deploy race.** CI applies migrations **before** deploying the new Worker, so for the
  length of that gap the old Worker runs against the new schema. No `NOT NULL` column without a
  default, no rename, no drop of a column the deployed Worker still reads. A contraction needs the
  two-step release — expand, deploy the Worker that uses it, contract in a later change.
- **Installed desktop builds never update**, in *both* directions. A build from a year ago keeps
  calling `auth:*` against the current Worker forever, and unlike a D1 mistake that is not
  recoverable by a redeploy.
  - *Responses*: a removed or renamed field in a handler under `apps/auth-api/src/routes/v1/` or
    `v2/` breaks the clients that still read it.
  - *Requests*: an old build also keeps sending its original routes, methods, headers and bodies.
    Making an optional request field required, tightening a validator, rejecting a value that used
    to be accepted, or adding an auth requirement breaks those clients even when every response
    shape is untouched. Diff the request parsers and route registrations, not only the responses.

```bash
bun run --cwd apps/auth-api test:server test/mobile-auth-migration.test.ts
```

`apps/auth-api` has its own vitest config, so `bun run test:desktop` does not reach it. Run the
sibling `*-migration.test.ts` files in `apps/auth-api/test/` that cover what you touched.
`bun run check:api` is CI's job, not yours.

### F. The updater itself — `electron-builder.yml`, `src/main/update-service.ts`, `package.json`

Triggered by a change to any of those, or to `package.json` dependencies.

- `appId`, the `publish` owner and repo, `artifactName` and `electronUpdaterCompatibility` are
  unchanged. A changed `appId` breaks the update feed and the `safeStorage` files at once — the
  users who lose their credentials are exactly the ones who successfully updated.
- **An `electron-updater` version bump means re-verifying the four non-public behaviours**
  documented on `UpdateAdapter` in `src/main/update-service.ts`: `MacUpdater.updateDownloaded` only
  asks Squirrel to stage while `autoInstallOnAppQuit` is on, `MacUpdater.quitAndInstall` stages on
  demand, every available check mints and returns a cancellation token, and
  `BaseUpdater.quitAndInstall` can return without quitting. Then update `VERIFIED_VERSION` in
  `src/main/electron-updater-assumptions.test.ts`. Retyping that version without re-verifying is
  the exact failure the test exists to catch, and issue #152 is what it cost last time.
- New `extraResources` or a bundled model breaks the size gates:
  `scripts/verify-update-artifacts.ts` rejects an update artifact over 700 MiB and a DMG over
  750 MiB, and `.github/workflows/release.yml` additionally rejects a macOS ZIP that is not smaller
  than the `v0.1.21` ZIP it downloads to compare against.

```bash
bun run test:desktop -- src/main/electron-updater-assumptions.test.ts
```

### G. Reverse states and the changelog

Always triggered. There is no path that exempts a release from these.

- **Any state this release lets a user enter but not leave is a bug, not a release note.** Snooze
  needs unsnooze, pause resume, revoke reconnect, mute unmute. Walk the new user-facing states in
  the diff and name the exit for each.
- **Anything requiring a user action after upgrade goes in the `CHANGELOG.md` entry in bold.** The
  precedent is the paired-phones note currently under `## [Unreleased]`: it states the action, why
  the upgrade forced it, and what is *not* lost. Copy that shape. A user who has to act and is not
  told files a data-loss bug.

## Step 3 — report and hand off

Report a table:

| Gate | Triggered by | Verdict |
| --- | --- | --- |
| A. SQLite schema | *path, or "not triggered"* | pass / stop / needs a human |

Then state the stops explicitly. Any one of these means **the version is not cuttable yet**:

- a modified or deleted frozen Team API codec or fixture;
- a DDL migration not mirrored into `LATEST_SCHEMA_SQL`;
- a renamed on-disk file, or a bumped stored `version`, with no read path for the old one;
- a D1 contraction without the two-step release;
- a changed `appId`, `ElectronTeamID`, or `publish` target.

If every gate passes, say so and hand off: `docs/RELEASING.md` owns the publish — the preflight
checklist, the compatibility matrix, signing, notarization, the canary update and the size gates.
