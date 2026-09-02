# Testing guide

This document decides **whether** a test is required, **which type** it should be,
and **where** it belongs. Read it before writing a test at any seam listed in
section 4.

The prohibitions live in the "Test value policy" section of `AGENTS.md` and are not
repeated here. This document adds the part that policy leaves out: the vocabulary of
test types we actually want, and the seams where one is mandatory.

The default failure mode this guide exists to prevent is not a missing test. It is
a suite that grows where rendering is easy and stays thin where a defect is
expensive. Coverage is not a goal and is not measured.

## 1. Before you write a test

Answer three questions in order. If the first has no answer, stop.

1. **What consequence does this test protect?** Valid answers: user data loss or
   corruption, a bypassed trust or permission boundary, a broken released contract
   (IPC, wire protocol, database schema), unrecoverable state after a crash or a
   corrupt file, an incorrect result the user cannot see is wrong, or a regression
   you have reproduced. "It increases coverage", "the function is new", and "the
   component renders" are not answers.
2. **What is the lowest stable boundary that can observe it?** Prefer a pure
   function over a service, a service over IPC, IPC over the rendered app. Test a
   rule exactly once, at that boundary.
3. **Can this test fail for any reason other than the behaviour breaking?** If a
   change to markup, wording, styling, layout, or a variant can turn it red, it is
   the wrong test. Rewrite it or delete it.

## 2. Choose the mechanism before the assertion

Several mechanisms in this repository are cheaper and stricter than a test. If one
of them can enforce the rule, **do not write a test.**

| Mechanism | Where | Use it for |
| --- | --- | --- |
| `tsc` | `bun run typecheck` (8 projects) | type shapes, exhaustiveness, nullability |
| Biome + 17 GritQL rules | `biome.json`, `tools/biome/anti-slop/rules/` | syntactic rules, unsafe assertions, module mocking, focus/class/style/containment/tooltip matchers |
| `scripts/ui-foundation-check.ts` | `bun run check:ui` | native controls outside `components/ui`, colour/size/radius literals in inline styles |
| `scripts/test-value-check.ts` | `bun run check:tests` | class-name `querySelector`, `document.activeElement`, raw-HTML and computed-style assertions, DOM walks, foreign `data-testid`. Its budgets may only decrease |
| Storybook, by hand | `bun run storybook` | every visual and animation detail |
| vitest project `node` | `src/backend`, `src/main`, `src/preload`, `scripts`, `packages/contracts`, and every `src/renderer/**/*.test.ts` | **the default.** Anything separable from the DOM |
| vitest project `renderer` (jsdom) | `src/renderer/**/*.test.tsx` | only component behaviour that cannot be extracted |
| real-Electron smoke | `scripts/browser-smoke.ts` (`test:browser`, runs in CI) | behaviour that only exists in the real runtime |
| live smoke scripts | `test:filesystem`, `test:storage-live`, `test:grok-live`, `test:codex`, `test:team-live`, `test:remote-desktop-runtime` | provider and network reality; manual by design, never in CI |

Project boundaries are defined in `vitest.config.ts` and follow the file extension:
`src/renderer/**/*.test.ts` runs in `node`, `*.test.tsx` in jsdom. So the project is not
a decision — the extension you pick is. A logic test that turns out to need jsdom is a
signal the logic is not separable from the DOM yet.

## 3. Test types we want

Seventeen types, ordered by consequence. Fifteen of them run in the `node` project.
Use these names in pull requests and review comments.

### Boundaries and contracts — project `node`

1. **Contract test** — that two sides of a boundary agree. An IPC channel cannot
   exist in the contract and in the preload without a registration in main; a second
   implementation of an API cannot drift from the first. Fails when someone adds one
   side without the other. No pattern in the repository yet; this is the largest gap.
2. **Trust-gate test** — that a gate *rejects*. An untrusted `senderFrame.url` never
   reaches the wrapped handler; the CSP admits exactly the origins the code actually
   produces. Assert the refusal, not the happy path.
3. **Hostile-input test** — malformed, oversized, and unknown-shape payloads.
   Known-but-broken fails closed; unknown-but-optional is ignored. Every input parser
   and every response decoder.
4. **Frozen fixture** — one set per released format, both directions (old client
   against new host and the reverse). Never edited, only appended. Pattern:
   `packages/contracts/src/team-protocol/`, the best-covered seam in the repository.

### Data durability — project `node`

5. **Data-preservation migration test** — apply a released schema, seed realistic
   data, migrate, assert nothing was lost. Plus failure, rollback, retry, downgrade,
   missing version, `foreign_key_check`, and `integrity_check`. Applies to the
   desktop SQLite database and to D1. Pattern:
   `apps/auth-api/test/marketplace-migration.test.ts`.
6. **Corruption-recovery test** — truncated file, unknown `version`, garbage. This is
   a different test from a round-trip and a more important one: it must explicitly
   forbid degrading into a fresh identity or an empty collection. No pattern in the
   repository yet.
7. **Round-trip test** — encode, decode, compare; in both directions. Cheap, so write
   one for every serialized format.
8. **Bounded-growth test** — N writes produce a bounded number of rows. Required for
   every aggregate in an append-only log. Pattern: the conversation-snapshot case in
   `src/backend/openbot-database.test.ts`.
9. **Idempotency and concurrency test** — a replayed command id does not duplicate
   its effect; queue serialization; reconciliation after a crash; atomic persistence.
   Pattern: `apps/auth-api/test/auth-service.test.ts`.

### Logic correctness — project `node`

10. **Pure-logic test** — projections, reducers, parsers, state machines, schedulers.
    Runs in the `node` project **even when the module lives in the renderer** — name the
    file `*.test.ts` and it does. The cheapest tests in the repository and the best ratio
    of value to brittleness.
11. **Stream and ordering test** — assembly from partial and malformed chunks, event
    order, cancellation, process death mid-stream, timeout, reconnect. A provider
    client that only works on complete well-formed output is untested.

### Security

12. **Secret-redaction test** — no secret appears in a log or in a serialized
    payload, and a decryption failure is distinguishable from an expired session
    rather than presenting as a silent logout.

### External reality

13. **Assumption tripwire** — when a fake stands in for an external library at a
    boundary, pin the dependency version and document what must be re-read on a bump.
    Pattern: `src/main/electron-updater-assumptions.test.ts`. A green fake proves
    nothing about the real library; issue #152 shipped exactly that way.
14. **Real-Electron smoke** — `scripts/browser-smoke.ts`, runs in CI. Only for what
    exists exclusively in the real runtime: fuses, sandbox, protocol registration,
    window lifecycle.
15. **Live smoke** — the `test:*-live`, `test:filesystem`, `test:codex`, and
    `test:remote-desktop-runtime` scripts. Deliberately outside CI because they need
    local credentials. Run by hand before a release.

### UI layer — project `renderer` (jsdom), narrow

16. **Component-behaviour test** — only destructive-action confirmation, permission
    gating, error surfaces, and accessibility of a critical flow. One test per
    component contract, never per variant.

### Regressions

17. **Reproduced-regression test** — only when it reproduces the failure at a stable
    boundary and can prevent its return. If reproducing it requires clicking through
    the application, the boundary is too high: go lower, or do not write it.

## 4. Mandatory seams

A change touching one of these requires the listed types. Paths name the seam, not
an exhaustive file list. The "Security-sensitive changes" list in `CONTRIBUTING.md`
names the same boundaries from the reviewer's side.

| Seam | Paths | Required types |
| --- | --- | --- |
| Renderer-to-main trust boundary | `src/preload/index.ts`, `src/main/trusted-ipc.ts`, `trusted-renderer.ts`, `renderer-permissions.ts`, `content-security-policy.ts`, `src/main/ipc/*-inputs.ts`, `src/main/ipc/validation.ts` | 1, 2, 3 |
| IPC contract completeness | `packages/contracts/src/ipc-channels.ts`, `ipc.ts`, the registrations in `src/main/index.ts`, the preload surface | 1 |
| Second implementation of a contract | `src/renderer/src/preview/mock-openbot.ts` | 1 |
| Custom protocol schemes | the protocol handlers in `src/main/index.ts`, `src/backend/mailbox-store.ts`, `packages/contracts/src/attachment-files.ts` | 2, 3 |
| Database schema and migrations | `src/backend/openbot-database.ts`, `openbot-database-schema.ts` | 5, 6, 7 |
| Append-only aggregates | the event and snapshot writers in `src/backend` | 8 |
| Persisted JSON state | the `*-store.ts` modules in `src/main` and `src/backend` | 6, 7 |
| Secrets | `src/main/central-auth-manager.ts`, `remote-desktop-secret-store.ts`, `team-store.ts`, the `safeStorage` call sites, `apps/mobile/src/lib/mobile-auth.ts` | 12 |
| Provider process boundary | `src/backend/claude-client.ts`, `grok-client.ts`, `cli.ts`, `agent-service.ts`, `jsonl.ts`, `browser-host.ts`, `src/main/provider-runtime-manager.ts`, `host-service.ts` | 11, 3 |
| Team API wire protocol | `packages/contracts/src/team-protocol/` | 4, 1 |
| Updater | `src/main/update-service.ts`, `update-preference-store.ts` | 13 |
| Cloud services | `apps/auth-api`, `apps/site-router`, `remote/api` | 5, 9, 3, 2 |
| Mobile and team client | `apps/mobile`, `packages/team-client` | 10 |
| Pure logic anywhere | `src/renderer/src/app-message-projection.ts`, `dynamic-island-*`, `sidebar-*`, `src/backend/routine-schedule.ts`, `conversation-snapshots.ts`, `components/conversation/chat-search.ts`, `createChatVirtualizer.ts` | 10 |
| Renderer components | `src/renderer/src/components` | 16 |

Two notes on the seams above. Database migrations carry additional obligations
defined in the "Database migrations" section of `AGENTS.md`; read that section, not
just this row. Team API protocol compatibility is governed by its own section in
`AGENTS.md` in the same way.

CI applies D1 migrations **before** deploying the Worker, so every D1 migration must
be backward compatible with the currently live Worker. A migration that is not needs
a test proving the old Worker tolerates the new schema, or a two-step release.

## 5. What not to test

The "Test value policy" section of `AGENTS.md` is the authoritative list; follow it
there rather than looking for a copy here. In addition to it:

- **Snapshots.** There are none today. Keep it that way: they freeze output without
  stating intent and get updated reflexively.
- **How a fake was called.** No call counts, no argument ordering. Assert observable
  state and effect. Module mocking is already blocked by
  `tools/biome/anti-slop/rules/no-module-mocking.grit`; keep injecting dependencies
  through real interfaces, and prefer the real implementation whenever it runs
  locally — a temporary directory or an in-memory database usually means it does.
- **Anything the commit hook already rejects.** `toHaveFocus`, `toHaveClass`,
  `toHaveStyle`, `toContainElement` and `toHaveAttribute("title", …)` fail `biome check`
  in a test file. They stay available in `src/renderer/stories`, which is where visual
  and focus behaviour belongs.
- **Types, and third-party library behaviour.** `tsc` covers the first; a type 13
  tripwire is the correct answer to the second.
- **"Renders without throwing."** It protects no consequence.
- **Private functions and implementation details.** Test behaviour through the
  module's public surface. A test that restates the implementation fails with it and
  never before it.
- **Trivial mappings, getters, and 1:1 pass-throughs.**
- **A second end-to-end stack** (Playwright, Cypress). We have a real-Electron smoke
  script. A parallel framework means double maintenance and double flakiness for the
  same coverage.
- **Visual-regression and screenshot diffing.** Disproportionately brittle for a
  product whose appearance is still changing.
- **Wall-clock `sleep`.** Deterministic timers or nothing.
- **Benchmarks as tests.** Without a defined regression budget they only generate
  false alarms.
- **New modules that import `electron` at module scope with no seam to inject.** Tests
  that need Electron types use `import type` so they run in the `node` project.
  Follow that pattern; a module-scope `electron` import is a signal the logic belongs
  in a module without one.

## 6. Review checklist

- [ ] Every new test names a consequence from section 1 and a type from section 3.
- [ ] Each rule is tested once, at the lowest stable boundary.
- [ ] No test can fail from a markup, wording, or styling change alone.
- [ ] A change at a section 4 seam carries every type that row requires.
- [ ] New persisted state has a type 6 test that forbids silent identity loss.
- [ ] New released formats have frozen fixtures; existing fixtures are untouched.
- [ ] Tests are in the correct vitest project, and nothing was tested that a type or
      lint rule already enforces.
- [ ] No new cases were added to `src/renderer/src/App.test.tsx`.
