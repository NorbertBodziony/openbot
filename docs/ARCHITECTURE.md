# OpenBot architecture

OpenBot is a Bun workspace with one packaged desktop application, one cloud application, and small
packages for code that has more than one consumer.

## Workspace map

```text
apps/
  auth-api/          Cloudflare Worker, account login, invitations, and tunnel provisioning
packages/
  contracts/         Process and network boundary types, limits, and pure validation
src/
  backend/           Agent runtime, provider adapters, event storage, queues, and browser host
  main/              Electron lifecycle, trusted IPC, host server, and operating-system adapters
  preload/           Narrow typed bridge from Electron main to the renderer
  renderer/          SolidJS user interface
scripts/             Development, smoke, release, and package verification entry points
```

The desktop application stays at the repository root. Its package metadata is also the release
metadata used by Electron Builder and GitHub releases. Moving it into `apps/desktop` would create a
second version source and add package-signing risk without adding a useful runtime boundary.

## Dependency direction

Dependencies point toward stable boundaries:

```text
renderer ──► @openbot/contracts ◄── preload ◄── main ──► backend
                        ▲                             │
                        └──────── auth-api ──────────┘
```

- `packages/contracts` has no Electron, Node.js, SolidJS, provider, or Cloudflare dependency.
- The renderer cannot import `src/main` or `src/backend`.
- The preload bridge contains no business rules. It maps typed calls to IPC channels.
- Electron main validates untrusted IPC input before it calls a service.
- Provider code cannot write UI state. It sends events to `AgentService`, which writes SQLite
  projections before the main process sends changes to the renderer.
- The auth API cannot import desktop implementation files.

## State ownership

- `openbot.db` is the source of truth for OpenBot agents, conversations, queues, reactions,
  attachments, and provider-session bindings.
- `~/.codex` and `~/.claude` are provider-owned login and resume state. They are not OpenBot
  conversation storage.
- D1 is the source of truth for central accounts and the one-server-per-owner rule.
- A local team host owns team membership, invitations, and host sessions.
- Renderer signals are projections for the current screen only. They are not durable state.

## Change rules

1. Put a type in `packages/contracts` only when it crosses a process or application boundary.
2. Put a validation rule beside the contract when all consumers must use the same limit or syntax.
3. Keep provider-specific payloads inside the provider adapter. Translate them at ingestion.
4. Keep database schema changes in the schema module and add migration tests.
5. Keep Electron entry points small. New features use a service or a focused IPC input module.
6. Do not add a second linter or formatter. Biome is the only repository lint and format tool.
7. Do not add compatibility paths without a removal condition and a test for that condition.

## Required verification

Run `bun run check` for normal changes. Changes to packaging, native modules, or Electron security
also require the applicable macOS and Windows package verification commands. Live provider and team
smoke tests use isolated temporary data and are manual because they can require local credentials.
