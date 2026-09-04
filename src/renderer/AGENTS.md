# `src/renderer`

The UI stack sits on prerelease channels your training data does not cover: `solid-js@2.0.0-rc.0`
with `@solidjs/signals` and `@solidjs/web` at the same RC, `@kobalte/core@2.0.0-alpha.0` (patched
here), plus patched `lucide-solid` and `solid-sonner`. Do not trust your memory of these APIs: check
`package.json`, then read `.agents/skills/react-to-solid/docs/` (`kobalte-patterns.md`,
`corvu-patterns.md`, `base-ui-mapping.md`, `third-party-deps.md`) and
`.agents/skills/zaidan/references/`. Those two skills are vendored and re-synced from upstream, so
their code samples are 1.x-era and cannot be corrected here — `node_modules/solid-js/CHEATSHEET.md`
is the source of truth for core APIs, and where they disagree the cheatsheet wins. Read the skills
for the component patterns, not the imports.

- `bun run dev` for integrated work — it starts the local Auth API and the Electron dev app
  together. `bun run dev:api` is for API-only debugging.
- `bun run storybook` verifies isolated components. CI builds it; do not run `build-storybook`.
- Never verify UI with `dist/`, a packaged `.app`, a production build, or an ad-hoc preview — those
  are for release verification the user asked for. If the dev app will not start, report the blocker
  instead of falling back to one.

## Reactive state shape

**Prefer one `createStore` per concern over a row of `createSignal` calls.** Fields that change
together are one record — a saved-and-draft form pair, a `data`/`loaded`/`loading`/`error` quad, a
phase plus the numbers only one phase uses, several `Record`s keyed by the same `botId`. Declare the
shape up front, so replacing one field re-renders only what read that field; `FirstBotSetup.tsx` is
the form version. Keep the setter private behind named mutations where the store *is* a module's or
a hook's exported surface, as `app-stored-values.ts` and `createAsyncPanel.ts` do. Inside a
component, write the field where it changes — `setPanels((state) => { state.x = value; })` at the
call site, as `SettingsModal.tsx` does — and let a named mutation there earn its name: more than one
field, a guard or a side effect, or enough call sites that the name deduplicates something. A
function whose whole body is `state.x = value` is the signal wall one layer down. Ten keyed
`Record` signals are one row type shredded into ten columns, every write spreads the whole map so
every consumer of every key re-runs, and parallel signals let a screen hold states
the product does not have. `createSignal` still fits an element ref, a single measurement, a one-off
boolean, and a record you always replace whole. Stores come from `"solid-js"` — there is no
`solid-js/store` in this RC — hold plain values rather than accessors, and are never destructured.
A `Map` or `Set` never becomes a store — `isWrappable` rejects platform objects — so the
reference is the reactive unit: write a collection held in a signal by copying
(`new Set(current).add(id)`), and keep one you never read reactively in a closure.

## Component reuse

Search for an existing component, hook, style, utility or story first, and prefer reuse, composition
or a small extension. The shared layer is `src/renderer/src/components/ui` over patched Kobalte:
extend a primitive there rather than copying one into a feature, and update its story when it gains
a visual or interactive state. Build from scratch only after the search comes up empty, and keep it
reusable. The [Zaidan catalog](https://zaidan.carere.dev/docs/components) is a source of reference
*patterns*, not a dependency — it is not installed here; adapt its source to this repository's
SolidJS conventions, tokens, typography, spacing, icons and accessibility requirements.

## Design system

Use `lucide-solid` icons, and reuse a suitable one before adding an inline SVG or a local icon
component — document the exception next to any custom icon. The `:root` properties in
`src/renderer/src/styles.css` are the palette: use the closest semantic `--openbot-*` token,
including opacity variants, instead of a colour literal, and add a token only for a new semantic
role. Keep compatibility aliases that are in use, and isolate fixed integration, generated-asset,
SVG and platform colours at their boundaries.

## What a drawn frame costs

A drawn frame is a style recalculation, a layout and a paint, so a continuous animation is priced by
how often it draws times how many are on screen — not by how large it is. Left uncapped, one 36 px
agent avatar drawing at a 75 Hz display's rate measured 22.6 % of the renderer process; the same
avatar capped at 30 measured 8 to 10 %. Hence `AVATAR_FPS` in `AgentAvatar.tsx`, and hence bloub's
`autoPause`, which is on by default and stops the loop when nobody can see the bot.

`AgentAvatar` is the only place in the product that animates a `BloubBot`, and it is the funnel that
keeps this true: the static SVG in `bloub-avatar.tsx` uses `frozenAt` (no loop at all, which is what
makes it safe to render into a detached node), mobile samples a single frame from `BotEngine`, and
`packages/brand` carries only profile and catalogue data. A new animated bot placed anywhere else
needs its own cap, so reuse `AgentAvatar` instead.

## Waiting in a renderer test

`*.test.tsx` renders JSX in jsdom; `*.dom.test.ts` is the narrow case of needing a DOM without a
component. Needing either for logic means the logic is not separable from the DOM yet.

| Barrier | Use it for |
| --- | --- |
| `await screen.findByRole(role, { name })` | The normal case. It retries until the element exists, so it *is* the wait — a `getBy*` after a manual wait is the same query with a worse failure message. |
| `await screen.findByText(...)` | Copy that is a product contract and has no accessible role of its own. |
| `emitAgentEvent(...)` and the other `emit*` bridges — `app-test-harness.ts` | Driving a main-process event into the renderer. Await a `findBy*` after it; do not wait on the clock. |
| `subscriberCounts()` — same file | Asserting a screen actually unsubscribed. This is how a leaked bridge subscription is caught. |
| `installOpenbotStub()` | The whole `window.openbot` surface. Extend the stub rather than reaching around it. |
| `vi.waitFor(() => expect(spy)...)` | A call that produces no visible change — an analytics event, an IPC invoke. |
| `vi.useFakeTimers()` + `vi.advanceTimersByTime(n)` | A debounce or a poll interval. Advancing the clock is input, not waiting. |

Never raise a `vi.waitFor` timeout to make a test pass: that is the sleep the `no-sleep-in-tests`
rule rejected, one layer down. Find the barrier, or add one. Animation timing is not a barrier and
not a subject — it belongs in a Storybook story.
