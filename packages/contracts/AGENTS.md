# `packages/contracts`

The IPC channel list, the IPC payload types, and the frozen Team API wire protocol. Everything here
is a contract someone else already implements — a shipped desktop build, a remote host, a renderer
mock — so the cost of a change is paid by code you cannot edit.

## Team API protocol compatibility

- Never use the application SemVer as a wire protocol version; application versions are diagnostic
  metadata only.
- Keep a frozen codec, adapter, and client and host fixtures for each released protocol under
  `src/team-protocol`, and one registered adapter per supported protocol. Do not serialize current
  IPC types across the boundary.
- Use capabilities for additive, optional behaviour; a missing capability disables only its own
  feature.
- A required field, a removed field, or a semantic change needs a new protocol version. Never change
  the meaning of a released one.
- Age, release count and SemVer distance are not reasons to remove an adapter. Removal needs a
  separate architecture decision — a security issue, data-loss risk, semantics that cannot be kept,
  or cost an adapter cannot contain — plus a changelog entry, update instructions, both
  update-direction tests, and clear UI text.
- Malformed known payloads fail closed as `protocol_error`. Unknown optional events are ignored.

## One channel list, four hand-written mirrors

`src/ipc-channels.ts` declares every channel. Three files mirror it by hand:

| Mirror | What it is |
| --- | --- |
| `src/main/index.ts` and `src/main/ipc/` | the `handleTrusted` registrations |
| `src/preload/index.ts` | the `invoke` calls the renderer actually reaches |
| `src/renderer/src/preview/mock-openbot.ts` | the second implementation Storybook and the preview run against |

The three mirrors are not enforced the same way, and the difference is worth knowing before you
reach for a test.

Between main and preload, `tsc` links the payload types but not the existence of either end: a
channel invoked with no handler type-checks and rejects at runtime.
`src/main/ipc-channel-coverage.test.ts` is that link — it reads both process sources statically and
fails on a channel either side is missing, an endpoint registered twice, or an orphan on either
side.

The mock needs no such test. Both it and the preload bridge are annotated `: OpenBotDesktopApi`, so
a missing method is `TS2741` and a method the interface never declared is `TS2353` — the type
checker already covers both directions, and under Tests rule 3 that is the end of it. What it cannot
cover is the *behaviour*: `mock-openbot.ts` is a product surface, not a test double, and it is what
the preview and every Storybook story exercise. A method that satisfies the type by returning an
empty array is a story that silently shows nothing.

Adding a channel still means all four files in the same change.
