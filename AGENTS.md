# Repository guidance

Two tiers. **Non-negotiable** items protect user data, released contracts, or the security boundary —
do not trade them away without an explicit decision from the developer. Everything else is a
**default**: good practice for this repository, and the developer's preference overrides any of it.
If the developer asks for something this file discourages, do it and say what you set aside. Never
argue back by citing this file.

## Non-negotiable

- **Migrations are irreversible.** There is no automatic copy of `openbot.db` before an upgrade.
  Preserve all user data, support every shipped source schema, and never depend on a backup existing.
  See [Database migrations](#database-migrations).
- **Released Team API adapters are permanent.** A shipped wire protocol never changes meaning.
  See [Team API protocol compatibility](#team-api-protocol-compatibility).
- **The renderer-to-main trust boundary holds.** Electron sandboxing, context isolation, navigation
  policy, and IPC sender validation stay intact, with their tests. Agents already run with
  `danger-full-access`; the process boundary is what is left.
- **Secrets stay redacted** on every path that logs, exports, or sends — diagnostics exports and
  analytics included.
- **The licence is PolyForm Noncommercial 1.0.0.** Do not add a dependency whose licence conflicts
  with it, and do not relicense a file.

`CONTRIBUTING.md` "Security-sensitive changes" lists the boundaries in full; `docs/ARCHITECTURE.md`
"Change rules" covers where a type, a validation, or a schema change belongs.

## Do not run repo-wide checks. CI owns the full suite.

Run the narrowest test for what you touched, plus `biome check <paths>` and a targeted `tsc` on the
project you changed. Do not run `bun run check`, `bun run check:desktop`, `bun run test`, or
`bun run build-storybook` — each of these takes minutes, and the desktop suite flakes under load, so
a red result tells you nothing about your change.

CI already owns all of it on every push:

| CI job | Runner | Command |
| --- | --- | --- |
| Check | `macos-14` | `bun run check:desktop` |
| Tests | `ubuntu-latest` | `bun run test:desktop`, `bun run test:sites` |
| API | `ubuntu-latest` | `bun run check:api` |
| Storybook build | `ubuntu-latest` | `bun run build-storybook` |

Use `bun run test:desktop -- <path>` for one desktop file. If you genuinely need a wider check, ask
for that one command. Permission for a wider check authorizes only the check that was named — not
another one, not a build, not a packaged app.

## Hit every surface

A change that works on the path you happened to open is the most common way to ship a half-change
here. Walk this list, and **say in your summary which items your change touched.**

- **Desktop renderer** (`src/renderer`), **mobile** (`apps/mobile`), and the **public web surface**
  (`apps/auth-api` — there is no separate landing app).
- **The three palettes.** `--openbot-*` is declared three times with no shared package:
  `src/renderer/src/styles.css`, `apps/auth-api/src/styles.css`, `apps/mobile/global.css`. Only the
  desktop one is checked by `bun run check:ui`. A new token is not automatically available elsewhere.
- **IPC contracts** in `packages/contracts` — and their second implementation,
  `src/renderer/src/preview/mock-openbot.ts`, which Storybook and the preview run against.
- **Reverse states.** Snooze needs unsnooze, pause needs resume, revoke needs reconnect, mute needs
  unmute. A state a user can enter and not leave is a bug.
- **Migrations**, plus the separate latest schema used for new databases.
- **Documentation**: the `README.md` command table, `docs/ARCHITECTURE.md`, `PRIVACY.md` when a
  change alters what leaves the machine.

## The three ways to hurt yourself

1. **The user's development database.** `bun run dev:seed` destroys and replaces the whole
   `OpenBot Dev` profile directory — real conversations, agents, and transfers. Its staging copy is
   transient and deleted on success, so it is not a safety net. `bun run dev:reset` deletes the app,
   test-client, and legacy host profiles outright. Never run either unless you were asked to.
   `bun run dev:seed --dry-run` inspects the seed without touching anything.
2. **The shared dev stack.** Several agents work in git worktrees on this machine at once. They share
   one profile and one set of default ports, so a second `bun run dev` fights the first and can leave
   a half-written profile behind. Reuse the running instance. If you truly need your own,
   `developmentUserDataName(profile, instanceId)` in `src/main/development-profile.ts` is the
   mechanism for an isolated one.
3. **Killing processes by pattern.** `pkill -f electron` or `pkill -f bun` kills the other sessions'
   work along with yours, mid-write. Target a PID you started yourself, or ask.

## Words we use

- **agent** — three unrelated senses. The OpenBot product concept (a persistent teammate; the table
  is `projection_agents`, but the code still says `BotStore`, `BotSummary`, `bot-${uuid}`,
  `~/OpenBot/Bots/<id>` — the rename is incomplete, expect both). A *coding* agent working on this
  repository. A *marketplace* agent (`ipc-marketplace-agents.ts`). **teammate** is prompt and
  marketing copy only, never a type. Human team members are `TeamMemberSummary`.
- **server** — four senses. A remote team server you join (`ServerSummary`, `servers:*` IPC). Your
  own Team API host (`HostStatus`, `host:*` IPC, `src/main/team-api-server.ts`). The cloud account
  API (`apps/auth-api`, `auth:*` IPC). An MCP server (`createSdkMcpServer`).
- **thread / conversation / provider session / team session / turn** — `thread` is the durable record
  (`projection_threads`). `conversation` is its read projection: no table, an IPC and renderer word.
  `provider session` is the deliberately private CLI-side resume state
  (`projection_provider_sessions`). `team session` is an authenticated remote connection. `turn` is
  the unit of exchange inside a thread.
- **routine** — a scheduled standing instruction attached to one agent
  (`projection_agent_routines`). Not the Claude Code `/schedule` sense.

## What OpenBot is

Four invariants you cannot derive from the code. They frame trade-offs, so check a change against
them before optimizing something else.

- **Local-first, not offline-only.** Agent workspaces, conversations, attachments, browser data, and
  team data stay on the computer that runs OpenBot. Codex connects to OpenAI, Claude to Anthropic,
  Grok to xAI; visited pages and plugins use the network. Both halves are true.
- **No cloud dependency for core function.** Cloudflare holds accounts, avatars, host configuration,
  memberships, invitations, and logical sessions — never chats, files, or commands. The app works
  without an account.
- **The user's SQLite is the source of truth.** Not a cache of something remote. This is why
  migrations are irreversible and why a backup cannot be assumed.
- **Teammates persist.** An agent keeps its workspace, thread, and identity across provider switches
  and restarts. A change that resets an agent to get a cleaner state is changing the product.

## Read the local API references before you write UI

The whole UI stack sits on prerelease channels your training data does not cover:
`solid-js@2.0.0-rc.0` with `@solidjs/signals` and `@solidjs/web` at the same RC,
`@kobalte/core@2.0.0-alpha.0` (patched in this repo), plus patched `lucide-solid` and `solid-sonner`.
Do not trust your memory of any of these APIs — check `package.json`, then read the local notes:

- `.agents/skills/react-to-solid/docs/kobalte-patterns.md`, `corvu-patterns.md`,
  `base-ui-mapping.md`, `third-party-deps.md`
- `.agents/skills/zaidan/references/` for component selection patterns

## Renderer UI

- For integrated renderer UI work, use `bun run dev`. It starts the local Auth API and the Electron
  dev app together. Use `bun run dev:api` only for API-only debugging.
- Use `bun run storybook` to verify isolated components. Do not run `bun run build-storybook` for
  routine work; CI builds it.
- Never verify UI with `dist/`, a packaged `.app`, a production build, or an ad-hoc preview. If the
  dev app will not start, stop and report the blocker rather than falling back to a packaged app.
- Use packaged apps only when the user explicitly asks for release or package verification.

### Component reuse workflow

- Before adding UI, search the repository for a reusable component, hook, style, utility, or
  Storybook story. Prefer reuse, composition, or a small extension.
- The component layer is `src/renderer/src/components/ui`, built over patched Kobalte. Create or
  extend the reusable component there before using it in a feature; do not copy a shared primitive
  into a feature component.
- The [Zaidan catalog](https://zaidan.carere.dev/docs/components) is a source of *reference
  patterns*, not a dependency — it is not installed here. If it has a close match, adapt its source
  to this repository's SolidJS conventions, tokens, typography, spacing, icons, and accessibility
  requirements.
- Add or update the Storybook story when a shared component has a visual or interactive state
  Storybook can verify.
- Build from scratch only after both searches come up empty, and keep it reusable.

### Design system

- Use `lucide-solid` for renderer icons. Reuse a suitable Lucide icon before adding an inline SVG or
  a local icon component; document the exception next to any custom icon.
- The `:root` properties in `src/renderer/src/styles.css` are the renderer palette. Use the closest
  semantic `--openbot-*` token, including opacity variants, instead of a colour literal. Add a token
  only for a new semantic role. Keep compatibility aliases that are in use, and isolate fixed
  integration, generated-asset, SVG, or platform colours at their boundaries.

## Database migrations

- OpenBot does not create an automatic full copy of `openbot.db` before upgrading. Treat every
  migration as an irreversible production data operation: preserve all user data, support every
  shipped source schema, and never depend on a backup being available.
- Keep each schema change and its `schema_migrations` marker in the same transaction. Roll back on
  any error, restore foreign-key enforcement in `finally`, and run the integrity checks before
  allowing startup to continue.
- Never edit or delete a migration that may have shipped, including the frozen version 8 baseline.
  Append the next contiguous version and update the separate latest schema used for new databases.
- Migration changes require data-preservation fixtures for every affected released schema, plus
  failure, rollback, retry, downgrade, missing-version, foreign-key, and integrity coverage at the
  stable database boundary.
- Do not add automatic full-database migration backups. Their time and disk cost is unbounded because
  conversation history lives in SQLite; make the migration itself safe instead.
- The account service has a second, unrelated database. CI applies the D1 migrations under
  `apps/auth-api/migrations/` **before** deploying the new Worker, so every D1 migration must be
  backward compatible with the Worker still running. One that is not needs a test proving the old
  Worker tolerates the new schema, or a two-step release.

## Team API protocol compatibility

- Never use the OpenBot application SemVer as a wire protocol version. Application versions are
  diagnostic metadata only.
- Keep a frozen codec, adapter, and client and host fixtures for each released Team API protocol
  under `packages/contracts/src/team-protocol`.
- Keep one registered adapter for every supported protocol. Do not serialize current IPC types
  directly across the Team API boundary.
- Use capabilities for additive, optional behavior. A missing capability can disable only the related
  feature.
- Add a new protocol version for a required field, a removed field, or a semantic change. Never
  change the meaning of a released protocol.
- Do not remove an adapter because of age, release count, or SemVer distance. Removal requires a
  separate architecture decision for a security issue, data-loss risk, semantics that cannot be kept,
  or cost that an adapter cannot contain. Also add a changelog entry, update instructions, both
  update-direction tests, and clear UI text.
- Keep malformed known payloads fail-closed as `protocol_error`. Ignore unknown optional events.

## Tests

1. **The default answer is no test.** Prefer changing an existing test to adding one. A new test must
   name the consequence it protects; a new test *file* needs a boundary that does not exist yet.
2. **Check whether something already enforces it.** `tsc`, Biome and its GritQL anti-slop rules, and
   `bun run check:ui` cover a large class of rules mechanically. If one of them does, do not write
   the test.
3. **A test that needs a timeout to pass is wrong.** Wait on an observable condition — a state
   change, an emitted event, a resolved promise — never on the clock. A sleep long enough to pass on
   your machine is short enough to flake on a loaded runner.
4. **Test behaviour, data, and accessible roles and names** — not markup, classes, layout, animation
   timing, or where focus lands. Assert exact text only when it is a product contract, an error or
   security message, serialized output, or a localization key. Verify visual detail in Storybook.
5. **The file name picks the vitest project.** `src/renderer/**/*.test.ts` runs in `node` with no
   DOM, `*.test.tsx` renders JSX and gets jsdom, `*.dom.test.ts` is the narrow case of needing a DOM
   without rendering a component. Needing either of the last two for a logic test means the logic is
   not separable yet.
6. **A test is mandatory** when a change touches the renderer-to-main trust boundary, the IPC
   contract, database schema or migrations, persisted state, secrets, the provider process boundary,
   the Team API wire protocol, or the updater. Test it at the lowest stable boundary, once — not at
   both the component and the application level.

A test that only restates the markup is worse than no test: it costs a rewrite on every refactor and
fails for reasons no user would notice. Before adding an assertion, ask what a user or a caller would
see differently if it failed. If the answer is "a class name changed", "the colour changed", "the
element moved", or "the tree grew a node", drop the assertion — colour and layout belong in a
Storybook story, and the tree belongs nowhere. The same goes for how you reach the element: a
`data-testid` is a hook the product does not otherwise need and a CSS class is a styling detail, so
both tie the test to markup that is free to change. Query by accessible role and name. When nothing
accessible identifies the element, that is an accessibility gap in the component, not a reason for a
test id. Snapshots are the same failure in bulk: a snapshot names no consequence, so it cannot fail
for a reason anyone can act on — it gets updated, not read.

Biome enforces the mechanical half of that, and only the mechanical half. In test files it rejects
`toHaveClass`, `toHaveStyle`, `getComputedStyle`, `toContainElement`, `toHaveAttribute("title", …)`,
`expect(x.innerHTML)`, DOM-tree walks, `querySelector("svg" | "img")`, `document.activeElement`,
`toMatchSnapshot` and `toMatchInlineSnapshot`, `getByTestId` and `data-testid`, an assertion reached
through a CSS class, and awaiting a bare `setTimeout` promise inside a test body. Styling and layout
stay available in `src/renderer/stories`, which is where they belong.

Focus is the exception people expect to find here and will not. `toHaveFocus()` is *encouraged*: a
dialog that never moves focus inside itself, a roving tabindex that loses its place, a skip link that
goes nowhere — each is a defect only a keyboard user hits, and each regresses silently. Only
`document.activeElement` is rejected, because it asserts against the document instead of the element
the test already holds, and fails with "expected null" rather than naming the control.

The rules run at two severities, and the difference is a promise about how far you should bend for
one. **Error** is for patterns with no honest counter-example — a snapshot, a test id, a sleep.
**Warning** is for a judgement a pattern cannot make: `typeof` (right at a trust boundary that
narrows an `unknown`, wrong on a value whose type is already known), an `object` parameter, a module
mock. A warning is a prompt to think, never a demand to rewrite. Since `biome-ignore` is not
available to you, silencing a warning by making correct code worse is the one wrong answer; leave it
and say why in the PR.

Every rule in `tools/biome/anti-slop/rules` owns a fixture in `../fixtures` marking each line it must
reject with `// flag`, surrounded by adjacent correct code it must leave alone, and
`scripts/anti-slop-rules.test.ts` checks both halves. This is not ceremony: a GritQL pattern that
matches nothing is green and enforces nothing, which is how a rule stayed blind to
`querySelector<HTMLElement>` for months. A new rule without a fixture is not a rule.

## Pull requests

- **One topic per PR.** If the description needs the word "also", it is two PRs.
- **Never open a PR unless you were asked to.**
- Show before and after for a UI change.
- State the model and harness that produced the change in the body.
- Wider checks belong before the PR, not during it — ask for the specific command you need.

## Approvability

A PR is not auto-approvable, and needs a named reason in the body, when it:

- adds a `biome-ignore`, `@ts-expect-error`, or `@ts-ignore`;
- adds a rule-disabling entry to `biome.json` `overrides`, or unregisters a GritQL plugin;
- widens a type to `any` or `unknown` at a boundary, or adds a type assertion to get past a checker.

These are the exact escape hatches the anti-slop rules exist to close. Fix the finding at the domain
boundary instead; if the rule is genuinely wrong for a case, say so and let the developer decide.
