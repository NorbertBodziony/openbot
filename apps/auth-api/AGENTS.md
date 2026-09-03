# `apps/auth-api`

The Cloudflare Worker behind accounts, avatars, host configuration, memberships, invitations and
logical sessions. It never holds chats, files or commands, and the app works without it — a change
here must not become something core function depends on.

## D1 migrations run before the Worker that needs them

`migrations/` is a second, unrelated database to the user's SQLite in `src/backend`. CI applies
these migrations **before** deploying the new Worker, so for the length of that gap the old Worker
is running against the new schema. Every migration must be backward compatible with it: adding a
`NOT NULL` column without a default, renaming one, or dropping one the deployed Worker still reads
takes production down between the two steps.

One that cannot be backward compatible needs a test proving the old Worker tolerates the new schema,
or a two-step release — expand the schema, deploy the Worker that uses it, then contract in a later
change.

This is a different rule from the one in `src/backend/AGENTS.md`. There, migrations are irreversible
because they run on the user's own machine with no backup; here they are reversible but *raced*.
