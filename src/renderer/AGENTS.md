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
- `bun run check:ui` is the design-system guard for this directory: shared primitives over native
  controls, Kobalte and Lucide only inside `components/ui`, and palette tokens instead of colour,
  size, radius and transition literals. It reads the whole renderer in 60 ms, so run it on any
  change here rather than waiting for CI — its budgets only ever go down. All of them sit at zero
  except the `data-testid` hook count, frozen at the five already in the tree; root AGENTS.md says
  why that one is a ratchet instead of a ban.
- Nothing here imports `src/main`, `src/backend` or `src/preload`. `biome.json` rejects it by path,
  so reaching past the IPC contract fails `bun run lint` rather than review.
- Never verify UI with `dist/`, a packaged `.app`, a production build, or an ad-hoc preview — those
  are for release verification the user asked for. If the dev app will not start, report the blocker
  instead of falling back to one.

## Where a file goes

A domain lives in one directory: `src/renderer/src/features/<domain>/`, flat except for `stores/`.
Its context, its DOM-free logic, its pane, its components, its tests and its stylesheet are
siblings, so "fix the pin ordering" is answerable by opening one path. There is no barrel —
`components/ui/index.ts` is still the only one — and every import stays relative, which is what
makes `tsc` an exhaustive check after a move.

```
features/<domain>/
  <domain>-context.tsx   the domain context: createSimpleContext provider + use*() pair
  <domain>-scope.ts      the view-side composer, where one exists
  <Domain>*.tsx          entry component and rendered regions, PascalCase
  <domain>-*.ts          DOM-free logic, kebab-case
  <domain>.css           the stylesheet partial, @import-ed from styles.css in cascade order
  stores/                one create*Store per concern, plus *-actions.ts command bundles
```

**The context file is always `<domain>-context.tsx`**, even where nothing forces it. `sidebar.tsx`
and `Sidebar.tsx` coexisted only because they were in different directories; in one directory they
are the same filename on case-insensitive APFS. That breaks the `Check` job on `macos-14` alone
while every ubuntu job stays green, so the suffix is uniform rather than applied where a collision
happens to exist today.

**Outside a feature:** `components/ui` (the shared patched-Kobalte layer), the app shell and its
wiring (`App.tsx`, `AppView.tsx`, `app-providers.tsx`, `app-bootstrap.tsx`, `WorkspaceShell.tsx`,
`WorkspaceOverlays.tsx`, `lazy-views.ts`), the cross-domain modules every feature reads and none
owns (`navigation.tsx`, `layout.tsx`, `turns.tsx`, `providers.tsx`, `data.ts`,
`simple-context.tsx`, `scope-lifetime.ts`), `preview/` — whose mocks are the second implementation
of the IPC surface and belong beside `mock-openbot.ts` — and the base stylesheets
(`primitives.css`, `base.css`, `transitions.css`, `action-menu.css`, `sliding-tabs.css`) —
plus `app-shell.css`, which ends in a theme layer that assigns the palette across every domain
at once and cannot be split until that layer is lifted out; its header says so. Stories stay in
`src/renderer/stories/`, where the test rules relax.

A cluster earns a directory when the feature is the only thing that reads it. That test applies to
helpers and components, not to contexts: a context is read broadly by design, and `agents-context`
having eighteen readers is not evidence it belongs at the root. Something genuinely shared by two
domains stays flat rather than being imported sideways out of one of them.

## Reactive state shape

**Prefer one `createStore` per concern over a row of `createSignal` calls.** Fields that change
together are one record — a saved-and-draft form pair, a `data`/`loaded`/`loading`/`error` quad, a
phase plus the numbers only one phase uses, several `Record`s keyed by the same `agentId`. Declare the
shape up front, so replacing one field re-renders only what read that field; `FirstAgentSetup.tsx` is
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
`packages/brand/src/tokens.css` are the palette, shared with the web and mobile apps: use the
closest semantic `--openbot-*` token, including opacity variants, instead of a colour literal, and
add a token only for a new semantic role — there, not in a renderer stylesheet, which
`scripts/design-tokens.test.ts` rejects. Keep compatibility aliases that are in use, and isolate fixed integration, generated-asset,
SVG and platform colours at their boundaries.

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
