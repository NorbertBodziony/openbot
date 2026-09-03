# Repository guidance

Two tiers. **Non-negotiable** items protect user data, released contracts, or the security boundary;
trade one away only on the developer's explicit decision. Everything else is a **default** their
preference overrides — if they ask for something this file discourages, do it and say what you set
aside. Never argue back by citing this file.

## Non-negotiable

- **Migrations are irreversible.** Nothing copies `openbot.db` before an upgrade. Preserve all user
  data, support every shipped source schema, never assume a backup exists.
- **Released Team API adapters are permanent.** A shipped wire protocol never changes meaning.
- **The renderer-to-main trust boundary holds** — Electron sandboxing, context isolation, navigation
  policy, IPC sender validation, and their tests. Agents already run with `danger-full-access`; the
  process boundary is what is left.
- **Secrets stay redacted** on every path that logs, exports, or sends, diagnostics and analytics
  included.
- **The licence is PolyForm Noncommercial 1.0.0.** No dependency that conflicts with it, no
  relicensed file.

The first three are spelled out where they are enforced — `src/backend/AGENTS.md`,
`packages/contracts/AGENTS.md` and `src/main/AGENTS.md`. `CONTRIBUTING.md` "Security-sensitive
changes" lists the boundaries in full; `docs/ARCHITECTURE.md` "Change rules" says where a change
belongs.

## Do not run repo-wide checks. CI owns the full suite.

Run the narrowest test for what you touched, `biome check <paths>`, and a targeted `tsc` on the
project you changed. Do not run `bun run check`, `check:desktop`, `test`, or `build-storybook`: each
takes minutes, and the desktop suite flakes under load, so a red result tells you nothing about your
change. CI owns all of it on every push:

| CI job | Runner | Command |
| --- | --- | --- |
| Check | `macos-14` | `bun run check:desktop` |
| Tests | `ubuntu-latest` | `bun run test:desktop`, `bun run test:sites` |
| Surfaces | `ubuntu-latest` | `bun run mobile:typecheck`, `bun run typecheck:sites`, `bun run typecheck:team-client` |
| API | `ubuntu-latest` | `bun run check:api` |
| Storybook build | `ubuntu-latest` | `bun run build-storybook` |

`bun run test:desktop -- <path>` runs one desktop file. Need something wider? Ask for it. Permission
covers the one command named — not another one, not a build, not a packaged app.

## Hit every surface

A change that works on the path you happened to open is the most common half-change here. **Say
which of these your change touched.**

- **Desktop renderer** (`src/renderer`), **mobile** (`apps/mobile`), **public web**
  (`apps/auth-api` — there is no separate landing app).
- **The three palettes.** `--openbot-*` is declared separately in `src/renderer/src/styles.css`,
  `apps/auth-api/src/styles.css` and `apps/mobile/global.css`, with no shared package. Only the
  desktop one is checked by `bun run check:ui`, so a new token is not available elsewhere for free.
- **IPC contracts** in `packages/contracts`, and their second implementation
  `src/renderer/src/preview/mock-openbot.ts`, which Storybook and the preview run against.
- **Reverse states.** Snooze needs unsnooze, pause resume, revoke reconnect, mute unmute. A state a
  user can enter and not leave is a bug.
- **Migrations**, plus the separate latest schema used for new databases.
- **Documentation**: the `README.md` command table, `docs/ARCHITECTURE.md`, and `PRIVACY.md` when
  what leaves the machine changes.

## The three ways to hurt yourself

1. **The user's development database.** `bun run dev:seed` destroys and replaces the whole
   `OpenBot Dev` profile — real conversations, agents, transfers — and its staging copy is deleted
   on success, so it is not a safety net. `bun run dev:reset` deletes the app, test-client and legacy
   host profiles. Never run either unless asked; `dev:seed --dry-run` inspects without touching
   anything.
2. **The shared dev stack.** Several agents work in worktrees on this machine at once, sharing one
   profile and one set of default ports, so a second `bun run dev` fights the first and can leave a
   half-written profile behind. Reuse the running instance, or get an isolated one with
   `developmentUserDataName(profile, instanceId)` in `src/main/development-profile.ts`.
3. **Killing processes by pattern.** `pkill -f electron` or `pkill -f bun` kills other sessions' work
   mid-write. Target a PID you started, or ask.

## Words we use

- **agent** — three unrelated senses: the OpenBot product concept (table `projection_agents`, but the
  code still says `BotStore`, `BotSummary`, `bot-${uuid}`, `~/OpenBot/Bots/<id>` — the rename is
  incomplete, expect both); a *coding* agent working on this repository; a *marketplace* agent
  (`ipc-marketplace-agents.ts`). **teammate** is prompt and marketing copy, never a type. Human team
  members are `TeamMemberSummary`.
- **server** — four senses: a remote team server you join (`ServerSummary`, `servers:*` IPC); your
  own Team API host (`HostStatus`, `host:*` IPC, `src/main/team-api-server.ts`); the cloud account
  API (`apps/auth-api`, `auth:*` IPC); an MCP server (`createSdkMcpServer`).
- **thread** is the durable record (`projection_threads`); **conversation** its read projection (no
  table — an IPC and renderer word); **provider session** the deliberately private CLI-side resume
  state (`projection_provider_sessions`); **team session** an authenticated remote connection;
  **turn** the unit of exchange inside a thread.
- **routine** — a scheduled standing instruction attached to one agent (`projection_agent_routines`).
  Not the Claude Code `/schedule` sense.

## What OpenBot is

Four invariants you cannot derive from the code. Check a change against them before optimizing
something else.

- **Local-first, not offline-only.** Workspaces, conversations, attachments, browser data and team
  data stay on the computer that runs OpenBot. Codex still connects to OpenAI, Claude to Anthropic,
  Grok to xAI, and visited pages and plugins use the network. Both halves are true.
- **No cloud dependency for core function.** Cloudflare holds accounts, avatars, host configuration,
  memberships, invitations and logical sessions — never chats, files or commands. The app works
  without an account.
- **The user's SQLite is the source of truth**, not a cache of something remote. This is why
  migrations are irreversible and a backup cannot be assumed.
- **Teammates persist.** An agent keeps its workspace, thread and identity across provider switches
  and restarts. Resetting an agent to get a cleaner state changes the product.

## Where the rest of this lives

Five directories carry rules this file used to hold. Each is loaded when you open a file under it,
and each says what its own boundary costs and how to wait in its tests.

| File | What it owns |
| --- | --- |
| `src/renderer/AGENTS.md` | the prerelease SolidJS stack, one store per concern, component reuse, the palette |
| `src/main/AGENTS.md` | the renderer-to-main trust boundary, and where an IPC endpoint is registered |
| `src/backend/AGENTS.md` | the user's SQLite: irreversible migrations, and the two database build paths |
| `packages/contracts/AGENTS.md` | the Team API wire protocol, and the one channel list with its three mirrors |
| `apps/auth-api/AGENTS.md` | the account Worker, and why its D1 migrations must survive a deploy race |

Read the one for the directory you are changing before you change it. `docs/ARCHITECTURE.md`
"Change rules" says where a change belongs when it is not obvious.

## Tests

1. **The default answer is no test.** Prefer changing an existing test to adding one. A new test
   names the consequence it protects; a new test *file* needs a boundary that does not exist yet.
2. **Watch it fail.** Break what it covers — change the value, delete the guard, return early — and
   confirm it goes red *for the reason you meant*. Still green means it tests nothing; "expected 3
   children, got 2" means it tests the tree, so fix the assertion before restoring the code. No
   linter can run this check, and it is what separates a test from a costume. Say in the PR that you
   did it.
3. **Check whether something already enforces it.** `tsc`, Biome with its GritQL rules, and
   `bun run check:ui` cover a large class mechanically. If one of them does, skip the test.
4. **A test that needs a timeout to pass is wrong.** Wait on an observable condition — a state
   change, an emitted event, a resolved promise — never the clock. A sleep long enough to pass on
   your machine is short enough to flake on a loaded runner. A spy call is such a condition:
   `await waitFor(() => expect(send).toHaveBeenCalled())` is the sanctioned way to satisfy this
   rule, and is not the mock-shaped assertion the module-mock warning is about. The barrier
   synchronizes; the assertions after it carry the consequence. Counting `toHaveBeenCalled*` across
   the suite cannot tell the two apart, so do not "fix" a barrier by grep.
5. **Test behaviour, data, and accessible roles and names** — not markup, classes, layout or
   animation timing. Where focus lands *is* behaviour: assert it with `toHaveFocus()`. Assert exact
   text only for a product contract, an error or security message, serialized output, or a
   localization key. Visual detail belongs in a Storybook story.
6. **The file name picks the vitest project.** `*.test.ts` runs in `node` with no DOM, `*.test.tsx`
   renders JSX in jsdom, `*.dom.test.ts` is the narrow case of a DOM without a component. Needing
   either of the last two for logic means the logic is not separable yet.
7. **A test is mandatory** at the renderer-to-main trust boundary, the IPC contract, database schema
   and migrations, persisted state, secrets, the provider process boundary, the Team API wire
   protocol, and the updater — at the lowest stable boundary, once, not at both the component and the
   application level.
8. **Never delete, skip or weaken a test to make a check pass.** A red test is information. Fix the
   code, or fix the test's premise and say in the PR what changed and why. Loosening an assertion
   until it goes green is the same move in disguise. `it.only` is rejected outright because it
   silently disables the rest of the file; a skip needs a comment naming what unblocks it.

Before adding an assertion, ask what a user or a caller would see differently if it failed. "A class
name changed", "the colour changed", "the element moved", "the tree grew a node" — drop it; colour
and layout belong in a story, the tree nowhere. How you reach the element counts too: a `data-testid`
is a hook the product does not otherwise need and a CSS class is a styling detail, so both pin the
test to markup that is free to change. Query by accessible role and name; nothing accessible to query
is an accessibility gap in the component, not a reason for a test id. A snapshot is the same failure
in bulk — it names no consequence, so it gets updated, not read.

Biome enforces the mechanical half and only that. In test files it rejects `toHaveClass`,
`toHaveStyle`, `getComputedStyle`, `toContainElement`, `toHaveAttribute("title", …)`,
`expect(x.innerHTML)`, DOM-tree walks, `querySelector("svg" | "img")`, `document.activeElement`,
snapshots, the `*ByTestId` queries, an assertion reached through a CSS class, an awaited bare
`setTimeout`, and `it.only`. It does not see a `data-testid` attribute itself — the paragraph above
is what rules that out. All of it stays available in `src/renderer/stories`, where it belongs. Around
focus only `document.activeElement` is rejected: it asserts against the document instead of the
element the test already holds, and fails with "expected null" rather than naming the control.
`toHaveFocus()` is encouraged.

Two severities. **Error** is for patterns with no honest counter-example: a snapshot, a test id, a
sleep. **Warning** is for a judgement a pattern cannot make — `typeof` (right when narrowing an
`unknown` at a trust boundary, wrong on a value whose type is already known), an `object` parameter,
a module mock. A warning is a prompt to think, never a demand to rewrite; `biome-ignore` is not
available to you, so making correct code worse to silence one is the one wrong answer. Leave it and
say why in the PR.

Every rule in `tools/biome/anti-slop/rules` owns a fixture in `../fixtures` marking each rejected
line with `// flag` beside correct code it must leave alone; `scripts/anti-slop-rules.test.ts` checks
both halves. A pattern that matches nothing is green and enforces nothing — that is how one rule
stayed blind to `querySelector<HTMLElement>` for months. A new rule without a fixture is not a rule.

## Pull requests

- **One topic per PR.** If the description needs the word "also", it is two PRs.
- **Never open a PR unless you were asked to.**
- Show before and after for a UI change, and state the model and harness in the body.
- Wider checks belong before the PR, not during it — ask for the specific command you need.

### Approvability

A PR is not auto-approvable, and needs a named reason in the body, when it adds a `biome-ignore`,
`@ts-expect-error` or `@ts-ignore`; adds a rule-disabling `overrides` entry to `biome.json` or
unregisters a GritQL plugin; or widens a type to `any` or `unknown` at a boundary or asserts past a
checker. These are the exact escape hatches the anti-slop rules exist to close: fix the finding at
the domain boundary, or say the rule is wrong for this case and let the developer decide.
