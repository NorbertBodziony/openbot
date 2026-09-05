# `src/backend`

The stores, the SQLite database (`openbot-database.ts` and the controllers under `database/`), the
provider clients and `agent-service.ts`. The user's SQLite is the source of truth here, not a cache
of something remote — which is what makes the first section below non-negotiable.

## Database migrations

- Nothing copies `openbot.db` before an upgrade. Every migration is an irreversible production data
  operation: preserve all user data, support every shipped source schema, never depend on a backup.
- Keep each schema change and its `schema_migrations` marker in one transaction. Roll back on any
  error, restore foreign-key enforcement in `finally`, and run the integrity checks before startup
  continues.
- Never edit or delete a migration that may have shipped, including the frozen version 8 baseline.
  Append the next contiguous version and update the separate latest schema for new databases.
- A migration change needs data-preservation fixtures for every affected released schema, plus
  failure, rollback, retry, downgrade, missing-version, foreign-key and integrity coverage at the
  stable database boundary.
- No automatic full-database backups: conversation history lives in SQLite, so their time and disk
  cost is unbounded. Make the migration itself safe instead.

### The two build paths

`openbot-database-schema.ts` builds a database twice. `createLatestDatabase` execs
`LATEST_SCHEMA_SQL` and then stamps every entry in `MIGRATIONS` as applied **without running it**;
an existing database runs them for real. A DDL migration that is not also mirrored by hand into
`LATEST_SCHEMA_SQL` therefore ships new installs a database missing that column while upgraded
installs get it, silently, on the user's machine.

`openbot-database-schema-parity.test.ts` builds a database both ways and compares the normalised
`sqlite_master` SQL and `PRAGMA table_info` per table, so that divergence is a red test rather than a
support ticket. Do not weaken it; a new DDL migration means editing `LATEST_SCHEMA_SQL` in the same
change.

The account service has a second, unrelated database — Cloudflare D1 — and its rule is the opposite
shape: those migrations are reversible but race a deploy. `apps/auth-api/AGENTS.md` owns it — nothing in this
directory touches `apps/auth-api/migrations/`.

## Waiting in a backend test

`*.test.ts` here runs in the `node` vitest project with no DOM. The barriers this directory already
offers, in order of preference:

| Barrier | Use it for |
| --- | --- |
| `waitFor(predicate)` — `agent-service-test-harness.ts` | Anything driven by the fake provider process. Polls to a deadline and fails naming *the predicate that never held*, printing the source of the check. |
| `nextRoutinesChanged(service, agentId)` — same file | One named `AgentEvent`. Resolves on the event; the pattern generalizes to any other event you need. |
| `callOpenBotTool(...)` / `expectOpenBotToolError(...)` | A tool round trip. Both already contain the wait. |
| `await service.someMethod()` | A promise the code under test already returns. Prefer it over observing a side effect of the same call. |
| `vi.waitFor(() => expect(...))` | A spy or a fake reaching a count, where there is no domain event to hang off. |
| `vi.useFakeTimers()` + `vi.advanceTimersByTime(n)` | A debounce, a retry backoff, a schedule. Advancing the clock is input, not waiting. |

`test-deadlines.ts` is why `waitFor` reports before vitest does: `NODE_TEST_TIMEOUT_MS` is derived
from `HARNESS_WAIT_TIMEOUT_MS` rather than written down twice, so a stalled wait fails with the
condition rather than with vitest's generic "test timed out". Never raise a `vi.waitFor` timeout to
make a test pass — a longer timeout is the sleep the `no-sleep-in-tests` rule rejected, one layer
down. Find the barrier, or add one.

**A fixed delay is only ever right as input**, never as a wait: modelling latency in a fake, testing
that a debounce does *not* fire early, and mtime granularity on a filesystem. All three read as
"this delay is the thing under test". If the delay is there so the code has time to finish, it is
wrong.

## Size

`mailbox-store.ts` is the largest file in this directory, at about 1,700 lines.

The two that used to be larger are both worth copying. `agent-service.ts` was split into eight
controllers; `openbot-database.ts` was split into nine under `database/`, leaving a ~300-line facade
that had to keep its class name, instance identity, constructor signature and public surface because
callers reach past it into `connection` and `dispatch`. The shape in both: one class per file,
kebab-case, `<Name>Options` + `<Name>`, `readonly #` fields, a constructor that only assigns, and a
doc comment saying what the class **owns** and that it never imports the facade. No barrel file.

Two rules those controllers depend on and a reader cannot infer. They hold the core object and read
`.connection` at each use — a cached handle survives `initialize()` and then silently addresses a
closed database after `close()`. And a projection controller does not open a transaction of its own.
Four places do, and each is load-bearing: `dispatch` and `deleteEventsAndReceipt` open one only if
they find none open, which is what lets a projector nest another dispatch inside the caller's, and
`ThreadReplay.rebuildThreadProjection` and the facade's `persistConversationAndMailbox` open one
unconditionally, which is what makes the dispatch inside each of them skip its own. Open an
unconditional one anywhere else and a caller already in a transaction gets a nested `BEGIN` that
SQLite rejects; remove one of these four and the replay or the mailbox write silently stops being
atomic.

Do not add a new concern to the biggest file you can see; extract one when a change gives you the
excuse.
