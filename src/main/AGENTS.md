# `src/main`

The Electron main process: the trust boundary, the windows, the lifecycle, and the services the
renderer is not allowed to reach directly. Everything here runs with the user's full privileges, so
the question for any change is not "does the renderer need this" but "what can a compromised
renderer do with it".

## Where an IPC endpoint goes

A renderer-to-main endpoint is **declared in `packages/contracts`** and **registered in
`src/main/ipc/`, one file per domain** — never inline in `index.ts`. `registerIpcHandlers` in
`./ipc/ipc-registry.ts` is a dispatcher and nothing else: it wires dependencies and calls one
`register*IpcHandlers` per
domain, so a reviewer can read a domain's whole surface in one file instead of finding it
interleaved with window and lifecycle code. `index.ts` calls it once with its module-level state
(the window, the pending invite, the analytics toggle). `register-team-handlers.ts` is the shape to copy — a
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

A fixed delay is only ever right as *input* — the interval a test configures a service with, an
artificial provider latency — never as the thing a test waits on.

`electron` cannot be imported outside an Electron process, so a test for anything in here mocks it.
`trusted-ipc.test.ts` shows the pattern: `vi.hoisted` a registrations `Map`, `vi.mock("electron")`
to capture into it, then invoke the captured listener with a fabricated sender frame. Mocking is
what the file under test forces, not a preference — a service that can be tested without it should
not import `electron` in the first place.

## Size

`index.ts` wires the dispatcher plus window and lifecycle code and should not grow handlers again.
`remote-server-manager.ts` is the outlier here; splitting it is its own change, but do not add a
concern to it because it is already the file that has too many.
