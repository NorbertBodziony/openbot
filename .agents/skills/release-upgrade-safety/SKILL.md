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

## Step 1 — establish the range, then account for every file in it

```bash
git tag --list 'v*' --sort=-v:refname | head -1
git diff --stat <tag>..HEAD
```

The audit is over that commit range, not over the working tree: an uncommitted edit is not what
ships, and a hazard three commits back is. State the tag and the changed-file count up front, and
run every gate's `git diff` over that same range.

**The diff drives the audit, not the trigger lists.** Take the whole changed-file list and assign
every entry to a gate or dismiss it by name:

```bash
git diff --name-status <tag>..HEAD
```

Each gate names the paths that obviously belong to it. Treat those as a starting point and never as
the authority: they are written by hand, they go stale, and a release can touch a file nobody
thought to list. The question a gate actually asks is "does this file carry the hazard I own", and
only the file in front of you answers that.

**Account for every file, but clear directories with a query and reserve prose for the residue.** A
release here runs to hundreds of files — the range audited when this skill was written was 942, of
which 212 were under `src/main` and `src/backend` alone. A rule demanding a sentence per file is a
rule you will skip, and skipping it is the one failure Step 1 exists to prevent. Bucket first:

```bash
git diff --name-only <tag>..HEAD | cut -d/ -f1-2 | sort | uniq -c | sort -rn
```

Then handle each bucket one of three ways, and say in the Step 3 table which one you used:

- **Dismissed as a bucket**, with the reason stated once. A bucket qualifies only if you can say
  what makes *every* file in it inert — `src/renderer/**` and `apps/mobile/**` ship in the same
  binary as their callers and write nothing a later build reads; `**/*.test.ts`, `docs/**` and
  `tools/**` are not in the shipped app at all. "Nothing looked interesting" is not a reason.
- **Cleared by a derived query.** This is how a large hazard-bearing directory gets honestly
  covered: gate B's `git grep` over `src/main` and `src/backend` names every file that decodes a
  versioned payload, so the other two hundred are cleared by the query having asked the right
  question of all of them. A bucket cleared this way inherits that gate's obligation — if the query
  returns nothing, the pattern is broken, not the bucket clean.
- **Named individually.** What is left: a file in a hazard-bearing directory that no bucket
  dismissal covers and no gate's query reached. This residue should be small. If it is not, that is
  itself the finding — report the count and say you could not account for it, rather than writing a
  dismissal you did not earn.

Work this way round because the failure this skill exists to prevent is almost never a hazard that
was examined and misjudged. It is one that was never looked at, because nothing pointed at it.

## Step 2 — the seven gates

Each gate is triggered by a path appearing in the diff. Work through all seven. A gate no path
triggered is reported as **not triggered** — never dropped silently, because "I did not look" and
"I looked and it was clean" are different verdicts and only one of them is a release gate.

`references/surfaces.md` holds the exhaustive path inventory. Load it when a gate fires and you
need the exact file, not before.

**Some checks below pass by producing no output. Prove the command can still speak before you trust
its silence** — run it over a range you know contains a hit, or confirm a list you expect to be long
is not empty. An empty result means "nothing is wrong" and "I asked the wrong question" equally
well, and the second is the more common of the two. This is not hypothetical: it is how `check:ui`
lost two checks (`AGENTS.md`, Tests) and why the repo deleted `no-runtime-typeof`.

### A. SQLite schema — `src/backend/openbot-database-schema.ts`

Triggered by any change to that file or to `src/backend/database/`.

- New entries in `MIGRATIONS` must **continue contiguously from the last version at the release
  tag**. Read that number, never remember it:

  ```bash
  git show "<tag>:src/backend/openbot-database-schema.ts" | grep -E 'version: [0-9]+' | tail -1
  ```

  A literal written into this file would go stale the first time a migration ships and would then
  reject the correct number. `validateMigrationRegistry` throws on a gap, so a skipped number is
  loud — but a *reused* one is a migration that never runs on any database that already applied it.

  **Quote the whole `<rev>:<path>` argument, and quote it even after you put the tag in a variable.**
  In zsh `$T:src/...` parses as the `:s` substitution modifier and dies with `bad substitution`
  before git runs — and only for paths starting `s`, so `$T:packages/...` works and teaches you the
  wrong lesson. The aborted command prints nothing, which is indistinguishable from a clean read.
  `"${T}:src/..."` is safe in both shells.
- **No shipped migration body may have changed.** Do not grep for `migrateTo` — only
  `migrateToBaselineV8` is spelled that way, so the grep comes back empty on a release that rewrote
  every other one. Derive the bodies from the registry instead:

  ```bash
  git show "<tag>:src/backend/openbot-database-schema.ts" | grep -E '^\s+up: [a-zA-Z]' | sort -u
  ```

  Read every hunk of the diff for each function it names, not the stat. A database that already
  applied version 12 will never apply it again, so an edit to it reaches new installs only and the
  two populations diverge. **One body can be `up:` for several versions** —
  `refreshProviderSessionsForDynamicTools` is currently the migration for 9, 10 and 14 — so a
  one-line edit there rewrites three shipped migrations at once, and the diff shows it as a single
  changed function far from any `version:` line.
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

### B. On-disk state outside SQLite — every decoder of a versioned file

Triggered by a change to `src/main/index.ts`, `src/backend/workspace-paths.ts`,
`src/main/sunshine-moonlight-runtime.ts`, `electron-builder.yml`, or **any file that decodes a
versioned payload**. Derive that last set instead of trusting a list — a serialization owner is not
always a `*-store.ts`, and `central-auth-manager.ts`, `main-window-state.ts` and
`skill-marketplace-service.ts` are three that are not:

```bash
git grep -lE 'version *(!==|===) *[0-9]|version: *z\.literal' <tag> HEAD -- \
  'src/main/*.ts' 'src/backend/*.ts' ':(exclude)*.test.ts' | sed 's/^[^:]*://' | sort -u
```

The gate fires if the release diff touches any file that prints. Three deliberate details:

- **Both revisions, unioned.** Searching `HEAD` alone means *removing* a version guard removes the
  file from the result, hiding the change most worth auditing. The tag alone misses an owner the
  release adds, and the tag side carries the pre-rename filename you need to spot a rename.
- **`z.literal` is a second spelling** — `remote-desktop-secret-store.ts` pins its version by schema
  and matches no comparison operator. Widen the pattern when you meet a third spelling rather than
  trusting this one.
- **No `\b`** — `git grep -E` is POSIX ERE, where it matches nothing and the list comes back empty.

The list is still only a starting point, and it is short enough to eyeball: if it prints nothing, or
far less than the file inventory in `references/surfaces.md`, the pattern is broken rather than the
release clean. Step 1 is what actually guarantees an unmatched file gets looked at — a persistence
change spelled in a way no pattern anticipates is caught by having to dismiss the file by name.

The trigger lives here rather than in `references/surfaces.md` because you classify triggers before
you open any reference; a trigger that pointed at the inventory would need the inventory read first,
and a file you did not already suspect would be classified as not triggered. Once this gate fires,
open the inventory for the file-by-file detail.

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
- **A read path is only the upgrade half — check the downgrade too.** Proving the new build reads
  every old shape says nothing about the old build reading the *new* one, and every file here is
  rewritten in place by whichever build opens it last. A user who rolls back to the previous
  release, or runs an older install beside the new one, hands the file to a reader that predates
  the bump. `src/main/dynamic-island-preference-store.ts` treats an unknown version as defaults and
  then rewrites the file at its own version, so shipping a `version: 4` under that filename means
  the older build silently discards the user's setting rather than leaving it alone. Before reusing
  a filename, read the reader **at the release tag** and confirm it refuses an unknown version
  instead of defaulting — `src/main/remote-server-stored-shape.ts` does, which is what makes it safe
  to bump. If it does not, keep the old file and write the new version beside it under a new name,
  the way `src/main/team-store.ts` keeps `-v1.json` and `-v2.json`.
  - The same asymmetry applies to `central-auth-manager.ts`, which is stricter still: an unknown
    shape *throws*, and `#initialize` catches that into `#clearStoredSession()`. The user is signed
    out, and because the file is `safeStorage`-encrypted there is nothing to recover by hand.
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

Let git match the frozen set. A protocol released since you last read this file is frozen too, so
nothing here names a version:

```bash
git diff --stat --diff-filter=MDR <tag>..HEAD -- \
  'packages/contracts/src/team-protocol/v*.ts' \
  'packages/contracts/src/team-protocol/fixtures/**' \
  ':(exclude)packages/contracts/src/team-protocol/v*.test.ts'
```

**Empty is the clean answer, but do not treat non-empty as rare.** The release audited when this
skill was written modified all four adapters and `v1.ts`, legitimately: renaming the product concept
forced the encode and decode halves apart, because they had shared one implementation only for as
long as the wire vocabulary and the app vocabulary were the same words. Expect to read hunks. What
the emptiness of this command actually buys you is that nothing frozen changed *without* you
noticing — so a non-empty result is the start of the work, and an empty one is only trustworthy if
you have proved the command can still speak.

Three things in that command are load-bearing:

- **Every pathspec is quoted, so git expands it and the shell never sees a glob.** Do not build the
  list into a variable: an unquoted expansion splits in bash and not in zsh, and the check then
  prints empty for the wrong reason. This gate's entire signal is its own emptiness, so before
  trusting a clean result, run it once over a range you know modifies a frozen file.
- **`v*.ts` covers the adapters.** `packages/contracts/AGENTS.md` freezes a codec, an adapter, and
  client and host fixtures for every released protocol, so `v1-adapter.ts`, `v2-adapter.ts`,
  `v3-adapter.ts` and `v3-webrtc-adapter.ts` are as frozen as `v1.ts`. A pattern anchored on
  `v[0-9]+\.ts$` matches one frozen file in five and passes while four broken adapters ship.
- **`--diff-filter=MDR`.** A released file *modified, deleted or renamed* is a broken contract with
  every peer still running an older build, and the fix is a new protocol version, never an edit.
  `R` is listed deliberately: git classifies a rename as `R` rather than `M`, so leaving it out
  lets a frozen fixture be renamed out from under the check while the diff still reports clean.
  `A` is left out because an added fixture is additive, and `v*.test.ts` is excluded because a test
  covering a frozen protocol may legitimately gain cases.

Read the additions separately with `--diff-filter=A` and confirm each is a genuinely new case
rather than the other half of a rename.

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

List the protocol tests for the same reason the diff is derived rather than typed, then run
`bun run test:desktop -- <path>` once per file it prints:

```bash
{ git ls-tree --name-only <tag> packages/contracts/src/team-protocol/
  git ls-tree --name-only HEAD packages/contracts/src/team-protocol/; } \
  | grep -E 'v[0-9]+\.test\.ts$' | sort -u
```

Union both revisions, as gate B does. The tag alone would skip a protocol the release *adds* — a
new `v4.test.ts` would never run, and the one codec with no shipped history is the one this audit
has the least other evidence about. `HEAD` alone would hide a frozen test the release *deleted*.

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
a change to any non-UI file under `apps/auth-api/src/`, or a change to any of the four files that
decide the deploy order: `.github/workflows/ci.yml`, `scripts/deploy-auth-api.ts`,
`apps/auth-api/package.json` and `apps/auth-api/wrangler.jsonc`.

The `src/` half is wider than `routes/` and `server/` on purpose: `worker-entry.ts` is the deployed
Worker's default export and `router.tsx` builds the router from `routeTree.gen.ts`, so a `/v1` or
`/v2` endpoint can be removed or shadowed there while every file under `routes/` is untouched.

The deploy-order files are in the list because the deploy-race hazard below is a property of *how
the deploy runs*, not of `apps/auth-api/`. **There are two independent paths and they must both
hold:**

- `.github/workflows/ci.yml` — "Apply production D1 migrations" runs before the Worker deploy in
  the same job.
- `scripts/deploy-auth-api.ts` — applies remote D1 migrations, then builds, then runs
  `wrangler deploy`. `apps/auth-api/package.json` `deploy` and `deploy:test` are its entrypoints,
  so a change to either can redirect or reorder the whole sequence.

Reorder those operations, drop the migration step, or split them across jobs, and production runs a
Worker against a schema it was never deployed against — with nothing under `apps/auth-api/src/`
modified and the gate otherwise reporting "not triggered". Re-read the order in **both** paths every
time one of these files changes; do not assume the order described here still holds, and do not
assume fixing one path covers the other.

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
  - **Indexes and triggers race too, and they are the ones that get missed** — the list above is
    about columns, and a migration can leave every column compatible while changing what the old
    Worker's writes *do*. A `CREATE TRIGGER` fires on statements the old Worker is already issuing.
    Swapping a `UNIQUE` index is worse: if the replacement is partial and predicated on a column the
    old Worker does not know to populate, its rows fall outside the new index and the constraint it
    was relying on silently stops being enforced for the length of the gap.
    `0018_remote_device_sessions.sql` is the worked example: it drops
    `remote_sessions_one_active_per_user_host` for a new index predicated on
    `auth_session_hash IS NOT NULL`, then keeps the old guarantee alive with a second
    `..._legacy_user_host` index covering exactly the rows the old Worker still writes. Copy that
    shape — when you narrow a unique index, add the legacy one beside it rather than assuming the
    gap is short.
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

Triggered by a change to any of those, to `package.json` dependencies, or to the two files that
enforce this gate at release time: `scripts/verify-update-artifacts.ts` and
`.github/workflows/release.yml`. A change that relaxes a size limit, drops a manifest or blockmap
check, or alters what gets published is exactly the change this gate should stop, and neither file
lives under the paths above — so without them listed, weakening the safeguard reads as "not
triggered". Diff the thresholds and the checks themselves, not only the code they guard.

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

- a frozen Team API codec, adapter or fixture that was deleted, renamed, or modified **in a way
  that can change what an encoded payload means** — the narrow exception gate C allows, a hunk that
  provably cannot alter the wire, is not a stop, and gate C is where that call gets made;
- a DDL migration not mirrored into `LATEST_SCHEMA_SQL`;
- a renamed on-disk file, or a bumped stored `version`, with no read path for the old one;
- a D1 contraction without the two-step release;
- a changed `appId`, `ElectronTeamID`, or `publish` target.

If every gate passes, say so and hand off: `docs/RELEASING.md` owns the publish — the preflight
checklist, the compatibility matrix, signing, notarization, the canary update and the size gates.
