# `src/main`

The Electron main process: the trust boundary, the windows, the lifecycle, and the services the
renderer is not allowed to reach directly. Everything here runs with the user's full privileges, so
the question for any change is not "does the renderer need this" but "what can a compromised
renderer do with it".

## Where an IPC endpoint goes

A renderer-to-main endpoint is **declared in `packages/contracts`** and **registered in
`src/main/ipc/`, one file per domain** — never inline in `index.ts`. `registerIpcHandlers` there is
a dispatcher and nothing else: it wires dependencies and calls one `register*IpcHandlers` per
domain, so a reviewer can read a domain's whole surface in one file instead of finding it
interleaved with window and lifecycle code. `register-team-handlers.ts` is the shape to copy — a
`*IpcDependencies` interface, object destructuring in the signature, no imports from `index.ts`.

Three things run at module scope in `index.ts` — `app.setPath`, `app.enableSandbox`,
`protocol.registerSchemesAsPrivileged` — which is why nothing in the main process can be imported
by a test that has not mocked `electron`, and why the coverage test below reads sources instead.

- `handleTrusted` / `handleTrustedWithEvent` from `./trusted-ipc` are the only registration
  primitives. `ipc-channel-coverage.test.ts` fails on the *name* `ipcMain` anywhere else in
  `src/main`, because an aliased import would register an endpoint with no sender check that no
  scan can see.
- Parse every argument, and the type checker holds you to it. A channel with a payload takes the
  decoder as the middle argument — `handleTrusted(channel, decode, handler)` — and the two overloads
  leave a handler that declares a parameter no way to typecheck without one, because
  `(input: unknown) => Result` is not assignable to the no-payload `() => Result`. `./ipc/validation.ts`
  has the primitives (`requireString`, `stringPayload`, `optionalPayload`, `nullishPayload`,
  `isObject`) and the `*-inputs.ts` files hold the per-domain parsers. Decoding runs *after* the
  sender check, so an untrusted frame never reaches a parser.
- Never write a channel name as a string literal. Every reference goes through `IPC_CHANNELS`, and
  the coverage test rejects a channel argument that is not a direct `IPC_CHANNELS.x` reference —
  a literal or a variable would hide the endpoint from every assertion in that file.
- Sending to the renderer goes through `sendToRenderer` in `./renderer-ipc.ts`, which drops the
  message on a destroyed or still-loading window rather than throwing into the emitter.

A domain module that is never called from `registerIpcHandlers` would otherwise be invisible: the
coverage scan reads sources, so an orphaned file still looks registered while every channel in it
rejects at runtime. `tsc` catches only half of it — deleting the call alone is `TS6133`, because the
call site is the import's only use, but deleting the import along with it compiles, and so does a
new registrar nobody wired up. "Calls every registrar under `src/main/ipc` exactly once from the
dispatcher" in `ipc-channel-coverage.test.ts` is the other half. Do not silence a `TS6133` here by
deleting the import; that turns the loud failure into the quiet one.

Adding a channel touches four files in one change: the contract, `src/main/ipc/`,
`src/preload/index.ts`, and `src/renderer/src/preview/mock-openbot.ts`. See
`packages/contracts/AGENTS.md` for what enforces which pair.

## The boundary is a Non-negotiable

Sandboxing, context isolation, navigation policy and sender validation are the whole reason the
process split exists — agents already run with `danger-full-access`, so nothing behind the boundary
is defence in depth. `trusted-renderer.ts` decides what an origin is, `renderer-permissions.ts` what
it may ask for, `content-security-policy.ts` what it may load. Each has a test, and a change to any
of them needs one. Widening `isTrustedRendererUrl` to accept a development convenience is the
single most expensive edit available in this directory.

The split is also enforced by path. `biome.json` gives `src/main`, `src/backend` and `src/preload` a
`noRestrictedImports` group rejecting `**/renderer/**`, and the renderer the mirror of it, so the
first import across the boundary fails `bun run lint` with the reason rather than passing review as
a convenience. `src/main` importing `src/backend` is the one direction left open, and 38 files use
it. Share a type through `packages/contracts` instead of reaching for the module.

## Waiting in a main-process test

A test that needs a timeout to pass is wrong (root AGENTS.md, Tests rule 4). These are the barriers
this directory already has, in the order to reach for them:

| Situation | Wait on |
| --- | --- |
| A service emits a status event | its own emitter — `provider-runtime-manager.test.ts` has the four-line `waitFor(manager, predicate)` that resolves on the first matching snapshot |
| A handler returns a promise | the promise. `handleTrusted` returns whatever the handler returns, so the registration captured by a mocked `ipcMain` is awaitable |
| A spy will be called, with no event to hold | `await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())` |
| A socket or server must be listening | `await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))` — the callback, never a delay |
| A debounce, retry backoff or poll interval | `vi.useFakeTimers()` and advance it. A real 300 ms wait is a flake on a loaded runner |
| A remote server reaches a state the renderer would see | `waitForServer(fixture, { state: "online" })` from `remote-server-test-harness.ts`, which fails with the diff against the whole summary rather than "expected undefined" |
| A remote host receives a request | `deferredRoute()` from the same harness — `await route.arrived` holds until the route is actually called, and `route.resolve(...)` releases it |

A fixed delay is only ever right as *input* — the interval a test configures a service with, an
artificial provider latency — never as the thing a test waits on.

Before writing a WebSocket or `fetch` fake for anything under `remote-server-*`, use
`remote-server-test-harness.ts`. It is a plain `.ts` contributing no `it`, in the shape of
`src/backend/agent-service-test-harness.ts`, and it exists because the suite had grown eight
hand-rolled socket fakes of which five declared `readonly readyState` — so closing one left it
reading OPEN and both `readyState !== WebSocket.OPEN` guards in the event stream were unreachable
from the tests that appeared to cover them. `FakeEventSocket` gets that right once. Its files split
`foo.ts` / `foo.test.ts`; the `agent-service.*.test.ts` pattern in `src/backend` is not the model
here, because that one divides the tests of a class that refused to divide.

`team-api-server.*.test.ts` is the one place that pattern *is* right, and for the same reason it is
wrong above: `TeamApiServer` is a class that will not divide. Every case drives real HTTP against a
real listener on a real port, so the only seam between two cases is the route they call - which is
why the suite is cut by domain, alongside the route modules, rather than by unit. Its fixtures are
`team-api-server-test-harness.ts`, and its header says what the harness will not default for you and
why each of those defaults would quietly change what a case tests. `host-service.test.ts` came out of
the same file: it was the block testing a different class.

`electron` cannot be imported outside an Electron process, so a test for anything in here mocks it.
`trusted-ipc.test.ts` shows the pattern: `vi.hoisted` a registrations `Map`, `vi.mock("electron")`
to capture into it, then invoke the captured listener with a fabricated sender frame. Mocking is
what the file under test forces, not a preference — a service that can be tested without it should
not import `electron` in the first place.

## Size

`index.ts` is the dispatcher plus window and lifecycle code and should not grow handlers again. Four
things that used to live in it now have their own file, and none of them should come back:

| File | What it owns |
| --- | --- |
| `main-window-state.ts` | reading, resolving and debounce-writing the window's saved position |
| `session-configuration.ts` | the renderer CSP, the permission handlers, the attachment/avatar/logo protocols |
| `renderer-forwarders.ts` | the eleven service events relayed to the renderer |
| `ipc/register-*-handlers.ts` | every IPC endpoint, one file per domain |

A dependency that may not exist yet when one of these is wired is passed from `index.ts` as a
**function** - `getAgentService: () => AgentService | null` - and read on every call, because most of
them are constructed during `app.whenReady()` before the services they reach are assigned, and a
captured `null` never recovers. A service that is already constructed is passed as the value:
`configureServerLogoProtocols` takes `remoteServers: RemoteServerManager`, and the IPC registrars
take their stores directly. Which of the two a dependency needs is the one thing here `tsc` cannot
decide for you - `() => X | null` and `X | null` both type-check at every call site.

`remote-server-manager.ts` used to be the outlier at 2828 lines. It is now the composition root of a
flat `remote-server-*` / `remote-*-decoding` family, and each of those files has exactly one reason
to change:

| Concern | File |
| --- | --- |
| the list of servers on disk, and its schema | `remote-server-store.ts`, `remote-server-stored-shape.ts` |
| one Team API call: negotiation, framing, decoding | `remote-server-client.ts`, `remote-server-http.ts`, `remote-server-errors.ts` |
| what a failure means to the user | `remote-server-connection-status.ts`, `remote-server-connections.ts` |
| the live event channel and its reconnect policy | `remote-server-event-stream.ts`, `remote-server-event-refresh.ts` |
| members, invitations, presence, host reconciliation | `remote-team-directory.ts`, `remote-server-presence.ts`, `remote-server-host-directory.ts` |
| what a host is allowed to send | `remote-host-decoding.ts` and its four wire-area siblings |

A new remote concern goes in the file whose one reason it shares, or in a new sibling next to them --
not in the manager, whose job is to own the IPC surface and wire these together. The manager is where
they *meet*: the request path never names the event stream and the event stream never names the error
path, so a callback passed in its constructor is how the two are connected. That indirection is the
design, not an accident to tidy up.

`team-api-server.ts` went the same way, one level down. The class, the WebSocket side and the
lifecycle stay in it; the routes live in `src/main/team-api/`, one file per domain, each exporting a
`route*(context, deps)` that answers `"handled"` or `"unmatched"` and declaring its own narrow
`*RouteDependencies` in the shape `src/main/ipc/` uses:

| Concern | File |
| --- | --- |
| the shared vocabulary: the class every route throws, the service types, the parsers, the context | `http-error.ts`, `dependencies.ts`, `request-helpers.ts`, `request-context.ts` |
| members, invitations, sessions, presence, the account routes behind auth | `route-team.ts` |
| one domain each | `route-remote-screen.ts`, `route-direct.ts`, `route-browser.ts`, `route-files.ts` |
| the agent collection and the sole `/v1/agents/:agentId` regex, which owns the four below | `route-agents.ts` |
| one agent sub-resource each | `route-agent-memories.ts`, `route-agent-routines.ts`, `route-agent-conversation.ts`, `route-agent-queue.ts` |

A new endpoint goes in the module for its domain, and nothing else has to be read. Four invariants
hold the split together, and the wire protocol is frozen (root AGENTS.md, Non-negotiable), so none of
them is a preference:

- **The gates run in order**: `compatibility`, then the remote-screen delegation, then the protocol
  gate, then a path-independent 401. `compatibility` first is what stops an out-of-date client
  looping on 426 with no way to read the endpoint telling it to update; the delegation above the
  protocol gate is because a browser fetching the viewer sends no protocol header and no token; the
  401 above the routes is why an unknown path without a token is 401 and not 404.
- **The dispatcher owns the only 404.** A module that does not serve a path *or its method* returns
  `"unmatched"` and never answers on its own. This is what keeps a wrong method on a known path
  answering 404 rather than 405, which is what the released clients were built against.
- **The dispatcher owns the only `catch`.** A local one would cut an unexpected error off from the
  logger and answer 400 where the truth was a 500.
- **`HttpError` has one definition**, in `http-error.ts`. The catch classifies by `instanceof`, so a
  second copy silently turns every 400 into a 500 and no round-trip test sees it.

The last statement of every route module is `return "unmatched"`, and what enforces that is the
declared `Promise<RouteOutcome>` rather than the convention: falling out of the end is TS2366,
"function lacks ending return statement". There is no `noImplicitReturns` here, so the annotation is
the whole guard - a module that drops it gets `undefined` inferred, and `undefined` reads as a silent
404. `tsc` covers this, so it does not want a test.

Three things are deliberately not unified, and each says so in its own file header: the `FromHost`
decoders and their `FromMain` twins in `src/preload/index.ts` (different trust boundaries), the HTTPS
V1/V3 and WebRTC V2 wire encodings (released protocols), and the control-plane methods on
`RemoteTeamDirectory` (a different server from the host).

Only the first of those three is also *checked*. `ipc-channel-coverage.test.ts` compares the set of
`decode*FromHost` names under `src/main` against the set of `decode*FromMain` names in the preload
and fails unless they match exactly, so neither half can lose its twin - which is how the pair gets
merged in practice: one is deleted, its callers point at the other, and trusted-sender validation
ends up applied to a remote team server. Adding a decoder to one side means adding it to the other.
The check enforces the naming bijection and nothing more; two names bound to one decoder still needs
a reviewer, and the test says so where it is defined.
