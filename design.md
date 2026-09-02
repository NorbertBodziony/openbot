# OpenBot design

This is the visual and interaction contract for OpenBot's user interface. It is the single source of truth for
how OpenBot looks and behaves, for humans and for agents.

Read it before you create or change any UI. Everything in it is traceable to a file in this repository; when the
document and the code disagree, that is a bug in one of them, and `bun run check:ui` fails on the parts of the
disagreement that can be detected automatically.

## How to use this document

| You are working on | Read |
| --- | --- |
| Desktop renderer (`src/renderer`) | This document. It is authoritative. |
| Mobile app (`apps/mobile`) | [`apps/mobile/DESIGN.md`](apps/mobile/DESIGN.md) first for component ownership, then this document for brand, tokens, and motion. |
| Landing and auth web (`apps/auth-api`) | This document for brand and tokens; the page styles live in `apps/auth-api/src/styles.css`. |

Two kinds of rules live here. **Mechanical rules** are enforced by `bun run check:ui` and cannot be negotiated in
a pull request. **Judgment rules** describe the taste this product is built with; they are enforced by review.
Both are binding. Where a rule has an enforcing check, this document says so.

If a change genuinely needs to break a rule, say so in the change: what the rule prevented, why no compliant
option worked, and what the fallback preserves. Do not break a rule silently.

## Brand and visual direction

OpenBot is a local-first desktop workspace for persistent AI teammates. The interface is a tool people keep open
all day, next to their editor. That drives every visual decision:

- **Dark-first, and on desktop dark-only.** The renderer sets `color-scheme: dark` and has no theme provider and
  no toggle. Do not add a light theme, a second palette, or a `prefers-color-scheme` branch to the desktop app.
- **Near-black, not blue-black.** The canvas is a neutral `#070707`. Surfaces step up in lightness, never in hue.
- **Compact and information-dense.** Control heights run 24-40px and body text is 13-14px. Chat, sidebar, and
  settings are meant to show a lot at once. Generous padding is not the house style.
- **Restraint, with one accent.** `--openbot-accent` (`#6960f1`) marks focus, selection, and the single most
  important thing on screen. A screen with three accents has none.
- **The signature move is inversion.** The primary button is a light pill (`--openbot-surface-light` with
  `--openbot-text-on-light`) on a near-black canvas. That contrast is the brand; do not tint it.
- **Product surfaces earn their chrome.** A `Card`, `Badge`, or `Alert` is justified by real grouping, state, or
  an action. Do not decorate a screen with containers that carry no information.
- **Copy is evidence-based.** Do not add a status, warning, or lifecycle claim the application state cannot
  actually support.

## Tokens

`src/renderer/src/styles.css` `:root` is the only place the renderer declares design tokens. Features, feature
stylesheets, and components consume them; they never redeclare a palette. Every color, text size, radius, and
transition duration in renderer CSS and in inline styles must be a `var(--openbot-*)` reference — this is a
mechanical rule, and `check:ui` holds all of its budgets at zero.

Add a token only for a genuinely new semantic role, in `:root`, and document it here in the same change.

The tables below inventory the **semantic vocabulary** — the tokens you choose from when you build a screen.
They are not a dump of `:root`. Component-local tokens (`--openbot-queue-*`, `--openbot-tabs-*`,
`--openbot-island-*` and their kind) and the legacy aliases at the end of the block are declared there without a
row here, because naming them in a contract would bury the vocabulary that matters. `check:ui` therefore
enforces the directions it can prove — every token this document names must be declared, every token the
renderer uses must be declared, and every literal value quoted in a table below must match the declaration — but
it cannot tell a new semantic role from new component plumbing, so adding a row for a token that deserves one
stays a review judgment.

### Surfaces

| Token | Value | Use |
| --- | --- | --- |
| `--openbot-bg-canvas` | `#070707` | Application background, the deepest layer |
| `--openbot-bg-sidebar` | `#111111` | Sidebar, server rail, panel chrome |
| `--openbot-bg-surface` | `#262626` | Dialogs, popovers, raised panels |
| `--openbot-bg-surface-raised` | `#2f2f2f` | A surface on top of a surface |
| `--openbot-bg-control` | `#1b1b1b` | Input and control fill |
| `--openbot-bg-control-hover` | `#313131` | Control hover, secondary button fill |
| `--openbot-bg-control-active` | `#3a3a3a` | Control pressed or selected |
| `--openbot-bg-glass` | `rgba(38, 38, 38, 0.76)` | Translucent floating surface |
| `--openbot-bg-overlay` | `rgba(7, 7, 7, 0.92)` | Full-surface scrim |
| `--openbot-surface-light` | `#f0f0f0` | Inverted surface: primary button, light island |

`--openbot-bg-host-canvas`, `--openbot-bg-host-header`, and `--openbot-bg-host-inset` are the embedded browser and
remote-host chrome. `--openbot-bg-notch` is the MacBook notch surface, which stays `#000000` to blend with the
hardware.

### Borders and text

| Token | Value | Use |
| --- | --- | --- |
| `--openbot-border` | `rgba(255, 255, 255, 0.08)` | Default separation |
| `--openbot-border-strong` | `rgba(255, 255, 255, 0.14)` | Inputs and anything that must read as an edge |
| `--openbot-border-focus` | `rgba(105, 96, 241, 0.72)` | Focused input border |
| `--openbot-text-primary` | `#f2f2f2` | Titles and primary content |
| `--openbot-text-secondary` | 72% white | Body copy and secondary content |
| `--openbot-text-readable` | 52% white | Long-form secondary copy that still has to be read |
| `--openbot-text-muted` | 48% white | Labels, metadata, ghost button rest state |
| `--openbot-text-placeholder` | 38% white | Input placeholders |
| `--openbot-text-dim` | 32% white | Decorative or de-emphasised detail |

The on-light family — `--openbot-text-on-light`, `--openbot-text-muted-on-light`, `--openbot-text-dim-on-light`,
`--openbot-border-on-light` — exists for content placed on `--openbot-surface-light`. It is for light islands
inside the dark UI. It is not a light theme, and it is not a reason to build one.

### Semantic colors

| Token | Value | Meaning |
| --- | --- | --- |
| `--openbot-accent` | `#6960f1` | Focus, selection, the one important action |
| `--openbot-accent-hover` | `#7a73ff` | Accent hover fill |
| `--openbot-accent-text` | `#a49fff` | Accent-tinted text |
| `--openbot-accent-soft` / `--openbot-accent-strong` | 16% / 34% accent | Accent wash / accent border |
| `--openbot-success` | `#61c985` | Completed, connected, healthy |
| `--openbot-warning` | `#e3b866` | Needs attention, approval pending |
| `--openbot-danger` | `#e47d75` | Failure and destructive state |
| `--openbot-danger-strong` | `#ff4058` | Unmissable danger, used sparingly |
| `--openbot-button-destructive` | `oklch(0.704 0.191 22.216)` | The destructive button ramp |

Each of `success`, `warning`, `danger`, and `accent` has a soft wash for backgrounds
(`--openbot-success-soft`, `--openbot-warning-soft`, `--openbot-danger-soft`, `--openbot-accent-soft`). Use the
wash for the surface and the solid token for the text or icon on it; never the solid token as a large fill.

The settings modal deliberately rescopes the accent family to the blue `--openbot-settings-accent` inside its own
subtree (`src/renderer/src/styles/settings-modal.css`). That is the only sanctioned local override of a palette
token, and it works because settings components consume the semantic name rather than the hex.

`--openbot-provider-claude`, the `--openbot-logo-*` set, the `--openbot-file-*` set, and the
`--openbot-data-table-*` set are fixed identity and integration colors. Use them by name; do not repurpose them.

Aliases at the end of the `:root` block (`--openbot-white`, `--openbot-hover`, and friends) are kept for existing
call sites. Do not use them in new code; use the semantic name.

### Typography

Inter Variable is self-hosted through `@fontsource-variable/inter`. Monospace is the platform stack. Both are
tokens: `--openbot-font-sans`, `--openbot-font-mono`.

The scale is absolute pixels, because the renderer is a fixed-density desktop surface.

| Size token | px | Leading token | px |
| --- | --- | --- | --- |
| `--openbot-text-nano` | 7 | `--openbot-leading-xs` | 14 |
| `--openbot-text-micro` | 8 | `--openbot-leading-sm` | 16 |
| `--openbot-text-2xs` | 10 | `--openbot-leading-md` | 18 |
| `--openbot-text-xs` | 11 | `--openbot-leading-lg` | 20 |
| `--openbot-text-sm` | 12 | `--openbot-leading-xl` | 22 |
| `--openbot-text-md` | 13 | `--openbot-leading-settings-title` | 24 |
| `--openbot-text-lg` | 14 | `--openbot-leading-2xl` | 26 |
| `--openbot-text-base` | 15 | `--openbot-leading-display` | 38 |
| `--openbot-text-xl` | 16 | | |
| `--openbot-text-settings-title` | 18 | | |
| `--openbot-text-2xl` | 20 | | |
| `--openbot-text-3xl` | 24 | | |
| `--openbot-text-4xl` | 28 | | |
| `--openbot-text-display` | 32 | | |
| `--openbot-text-5xl` | 40 | | |

Weights are `--openbot-weight-regular` 400, `--openbot-weight-medium` 500, `--openbot-weight-semibold` 600, and
`--openbot-weight-bold` 700. Tracking is `--openbot-tracking-tight` `-0.02em`, `--openbot-tracking-normal` `0`,
and `--openbot-tracking-wide` `0.02em`.

**Features do not choose a font size.** They choose a semantic role from `components/ui/typography.tsx`:

| `Text` `variant` | Size / weight / leading | Use |
| --- | --- | --- |
| `caption` | 11 / 400 / 14 | Metadata, timestamps, counts |
| `label-sm` | 12 / 500 / 16 | Dense labels, toolbar text |
| `label` | 13 / 500 / 18 | Form labels, list item titles |
| `body-sm` (default) | 13 / 400 / 18 | Default interface copy |
| `body` | 14 / 400 / 20 | Conversation and long-form copy |

| `Heading` `size` | Size / leading | Use |
| --- | --- | --- |
| `sm` | 14 / 20 | Section heading inside a panel |
| `md` (default) | 16 / 22 | Panel or dialog title |
| `lg` | 20 / 26 | Screen title |
| `display` | 32 / 38 | Onboarding and empty-state hero |

All headings are semibold with tight tracking. Pick the semantic element with `as` and the appearance with
`variant` or `size` — they are independent. Color comes from `data-tone`
(`primary | secondary | muted | danger | success | warning`), not from a `color` declaration.

### Spacing, radii, and sizing

Spacing is a 4pt scale: `--openbot-space-0-5` 2px, `--openbot-space-1` 4px, `--openbot-space-1-5` 6px,
`--openbot-space-2` 8px, `--openbot-space-3` 12px, `--openbot-space-4` 16px, `--openbot-space-5` 20px,
`--openbot-space-6` 24px, `--openbot-space-8` 32px. `--openbot-scrollbar-size` is 8px.

Radii are a family, not a slider — pick by element, not by taste:

| Token | px | Element |
| --- | --- | --- |
| `--openbot-radius-xs` | 4 | Inline chips, link buttons |
| `--openbot-radius-sm` | 6 | Skeletons, small insets |
| `--openbot-radius-md` | 8 | Buttons, inputs, menu items |
| `--openbot-radius-lg` | 12 | Cards, panels |
| `--openbot-radius-dialog` | 14 | Dialog and popover surfaces |
| `--openbot-radius-xl` | 20 | Large containers, stages |
| `--openbot-radius-bubble` | 22 | Chat bubbles |
| `--openbot-radius-modal` | 30 | Full modals |
| `--openbot-radius-pill` | 999 | Badges, avatars, pills |

Control heights carry meaning. Use the smallest one that fits the control's importance:

| Token | px | Use |
| --- | --- | --- |
| `--openbot-control-xs` | 24 | Helper and inline affordances |
| `--openbot-control-sm` | 28 | Toolbars and dense rows |
| `--openbot-control-md` | 32 | The standard control |
| `--openbot-control-lg` | 36 | Important actions, default button |
| `--openbot-control-xl` | 40 | Hero and onboarding actions |

Icon sizes are `--openbot-icon-xs` 12, `--openbot-icon-sm` 14, `--openbot-icon-md` 16, `--openbot-icon-lg` 20.
16px is the default in buttons and rows.

Shadows are `--openbot-shadow-raised` for floating surfaces, with `--openbot-shadow-dialog`,
`--openbot-shadow-dynamic-island`, and `--openbot-shadow-ring` for their named cases. Focus is always
`--openbot-focus-ring` (`0 0 0 3px` of accent wash). Do not author a new shadow.

Stacking is fixed: `--openbot-layer-dropdown` 40, `--openbot-layer-popover` 60, `--openbot-layer-dialog` 100,
`--openbot-layer-toast` 120. Do not invent a `z-index`.

### Motion

Desktop has no animation library. Motion is CSS custom properties plus transitions and keyframes.

| Token | Value | Use |
| --- | --- | --- |
| `--openbot-duration-hover` | `0ms` | Hover is instant, by design |
| `--openbot-duration-dialog` | `100ms` | Dialog content settle |
| `--openbot-duration-fast` | `120ms` | Small state changes |
| `--openbot-duration-normal` | `160ms` | The default transition |
| `--openbot-duration-slow` | `200ms` | Layout and size changes |
| `--openbot-duration-overlay` | `240ms` | Overlay enter and exit |
| `--openbot-ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Anything entering or settling |
| `--openbot-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Symmetric movement |
| `--openbot-ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Panels and drawers |

Principles:

- Motion explains a change of state. If it does not, remove it.
- Everything stays under 300ms. The toast and Dynamic Island content transitions
  (`--openbot-duration-toast-enter` and `--openbot-duration-island-content`, both 340ms) are the documented
  exceptions, because those surfaces travel in from off-screen.
- Reuse the named recipes in `src/renderer/src/styles/transitions.css` — `t-input` and `t-input.is-error`,
  `t-modal`, `t-page-slide`, `t-text-swap` — instead of writing a new keyframe. Their knobs
  (`--modal-open-dur`, `--page-slide-distance`, `--shake-distance`, and friends) are tokens too.
- Every motion path must respect `prefers-reduced-motion: reduce`. This is not optional and it is already honored
  in 35 files; match the pattern in the file you are editing.

## Layout

The workspace is a CSS grid declared in `src/renderer/src/styles/app-shell.css`:

- `.app-frame` — left panel, a zero-width seam, then content, with `--left-header-height: 38px`.
- `.app-frame-with-server-rail` — adds the leading rail. `--server-rail-width` is 64px, and 72px on macOS to
  clear the traffic lights. The rail renders only on `darwin` and `win32`.
- The left panel is resizable: 280px default, 240 min, 400 max, 88 compact, with 210/220 collapse-and-expand
  hysteresis so a drag cannot flicker (`src/renderer/src/App.tsx`). The width persists under
  `openbot:left-panel-width`.

`html`, `body`, and `#root` are `overflow: hidden` (`src/renderer/src/styles/base.css`). The page never scrolls;
individual panes own their scrolling. A new screen that scrolls the whole window is a bug.

Reading measures are capped, not fluid: a chat bubble is `max-width: min(80%, 720px)`, and the chat marker rail is
`min(680px, calc(100% - var(--openbot-space-6)))`. Full-width body text is not the house style.

## Components

`src/renderer/src/components/ui` is the public UI API. Features import from it and from nothing else.

**Mechanical rules**, all enforced by `check:ui` at budget zero:

- No native `<button>`, `<input>`, `<textarea>`, or `<select>` outside `components/ui`.
- No `@kobalte/core` or `lucide-solid` import outside `components/ui`.
- No hand-built `role="switch"`, and no hand-built `role="dialog"`, `"alertdialog"`, `"menu"`, `"tablist"`,
  `"tab"`, `"tabpanel"`, `"listbox"`, or `"option"`. Use the adapter.
- No color literal, and no untokenized `font-size`, `border-radius`, or `transition`, in a feature stylesheet or
  an inline style.

### Inventory

| Module | Exports |
| --- | --- |
| `typography.tsx` | `Text`, `Heading` (`TextVariant`, `HeadingSize`, `TextTone`) |
| `button.tsx` | `Button`, `IconButton`, `CopyButton`, `buttonVariants` |
| `badge.tsx` | `Badge`, `badgeVariants` |
| `form.tsx` | `Input`, `Textarea`, `NativeSelect`, `Label`, `Field` (`ControlSize`) |
| `checkbox.tsx` | `Checkbox` |
| `switch.tsx` | `Switch`, `SwitchField` (`SwitchSize`) |
| `select.tsx` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` |
| `surface.tsx` | `Card`, `Separator`, `Spinner`, `Skeleton`, `Kbd` |
| `item.tsx` | `ItemGroup`, `Item`, `ItemMedia`, `ItemContent`, `ItemTitle`, `ItemDescription`, `ItemActions` |
| `alert.tsx` | `Alert`, `AlertIcon`, `AlertContent`, `AlertTitle`, `AlertDescription`, `AlertActions` |
| `message.tsx` | `MessageGroup`, `Message`, `MessageAvatar`, `MessageContent`, `MessageHeader`, `MessageFooter` |
| `bubble.tsx` | `BubbleGroup`, `Bubble`, `BubbleContent`, `BubbleReactions`, `bubbleVariants` |
| `marker.tsx` | `Marker`, `MarkerIcon`, `MarkerContent` |
| `progress.tsx` | `Progress` |
| `radial-progress.tsx` | `RadialProgress` (`RadialProgressTone`) |
| `sliding-tabs.tsx` | `SlidingTabs` — `Root`, `List`, `Trigger`, `Content`, `ContentSlot` |
| `settings.tsx` | `SettingsSection` |
| `questionnaire.tsx` | `Questionnaire` — `Root`, `Progress`, `Item`, `Choice`, `Error` |
| `toast.tsx` | `Toaster`, `toast`, and the `solid-sonner` types it re-exports |
| `qr-code.tsx` | `QrCode` |
| `user-avatar.tsx` | `UserAvatar` |
| `server-gradient-logo.tsx` | `ServerGradientLogo`, `serverGradientLogoProfile` |
| `image-remove-button.tsx` | `ImageRemoveButton` |
| `dynamic-island.tsx` | `DynamicIsland` and its motion and state types |
| `dynamic-island-identity.tsx` | `DynamicIslandIdentity` |
| `icons.ts` | The curated Lucide re-exports |
| `complex.tsx` | `Dialog`, `AlertDialog`, `DropdownMenu`, `ContextMenu`, `Popover`, `Tooltip`, `Tabs`, `RadioGroup`, `SelectPrimitive`, `Combobox`, `Listbox` |
| `utils.ts` | `cx`, `truncateMiddle` |

### Which component do I pick

- **Immediate action** — `Button`, or `IconButton` when the icon is the whole control. Navigation inside a
  sentence is the `link` variant.
- **State or metadata** — `Badge`. It is not interactive; a clickable badge is a `Button`.
- **Ongoing work** — `Spinner` for an action in flight, `Skeleton` for content whose shape you already know.
- **A binary setting applied immediately** — `Switch`. If the decision needs a form submit, use `Checkbox` or
  `RadioGroup`.
- **One choice from a short list** — `RadioGroup`. From a longer list — `Select`. From a list that needs search or
  a custom value — `Combobox`.
- **A few peer views** — `Tabs`, or `SlidingTabs` when the segmented-pill treatment is wanted.
- **Actions anchored to a trigger** — `DropdownMenu`. Right-click actions — `ContextMenu`.
- **Light anchored information** — `Tooltip` for a word, `Popover` for more.
- **A focused task** — `Dialog`. An irreversible confirmation — `AlertDialog`.
- **A list of records** — `ItemGroup` with `Item`. A conversation — `MessageGroup`, `Message`, `Bubble`.
- **Something that needs attention in place** — `Alert`.

### Anatomy of the primitives that get misused

**`Button`** — `--openbot-radius-md`, `padding-inline: var(--openbot-space-4)`,
`gap: var(--openbot-space-1-5)`, medium weight, `line-height: 1`. Sizes map to control heights: `xs` 24, `sm` 32,
`default` 36, `lg` 40. Icon-only sizes are `icon-xs` 24, `icon-sm` 32, `icon` 36, `icon-lg` 40, and their glyphs
are 16px at `stroke-width: 1.75`. Variants:

| Variant | Use |
| --- | --- |
| `default` | The one primary action in a context — the light pill |
| `secondary` | Standard actions |
| `outline` | A bordered action on a busy surface |
| `ghost` | Toolbars and dense rows |
| `destructive` / `destructive-ghost` | Destructive operations |
| `link` | An action inside running text |

**`Badge`** — 20px tall, pill, 11px medium, 12px glyphs. Pick one of the Zaidan variants (`default`, `secondary`,
`destructive`, `outline`, `ghost`, the `*-light` washes, the `*-outline` set). The `tone`, `size`, `shape`, and
`dot` props are deprecated; do not use them in new code.

**`Input`, `Textarea`, `NativeSelect`** — one anatomy: `1px solid var(--openbot-border-strong)`,
`--openbot-radius-md`, `--openbot-bg-control` fill, 13/18 text. Heights are 28 / 32 / 36 for `sm` / `md` / `lg`.
`Textarea` starts at 76px and resizes vertically. Always wrap them in `Field`, which wires the label,
description, error, `required`, and `aria-describedby` for you.

**`Switch`** — 32x18.4 with a 16px thumb; `sm` is 24x14 with a 12px thumb. Off track is
`--openbot-border-strong`, on track is `--openbot-surface-light`.

### Icons and brand marks

Renderer icons are Lucide, imported only through `components/ui/icons.ts`. Reuse an existing export; if the icon
you need is missing, add it to that file rather than importing from `lucide-solid` in a feature. Add a custom SVG
only when Lucide has no suitable icon, and document the exception next to it.

Logos, avatars, and product artwork are OpenBot assets: `packages/brand` (`AppLogo`, `ProviderLogo`,
`PlatformLogo`, `logo.css`), `src/renderer/src/bloub-avatar.tsx` for generated user avatars, and
`components/ui/server-gradient-logo.tsx` for seeded server marks. Do not redraw them inline.

### Before you build a new component

1. Search this repository for a component, hook, style, utility, or Storybook story that already does it. Prefer
   reuse, composition, or a small extension.
2. If nothing fits, check the [Zaidan catalog](https://zaidan.carere.dev/docs/components) for the same component
   or a close match, and use its source as the starting point, adapted to this repository's SolidJS conventions,
   tokens, typography, icons, accessibility rules, and component API.
3. Build it in `components/ui` first, then use it in the feature. Do not copy a shared primitive into a feature.
4. Add or update its Storybook story when it has a visual or interactive state Storybook can show.

## Interaction states

Every interactive element needs all of the states that apply to it. This is the checklist reviewers use.

| State | The rule |
| --- | --- |
| Hover | Only inside `@media (hover: hover) and (pointer: fine)`, and instant (`--openbot-duration-hover: 0ms`). Never the only signal for anything. |
| Focus | `box-shadow: var(--openbot-focus-ring)`, plus `--openbot-border-focus` on inputs. Never remove an outline without replacing it. |
| Active | `transform: scale(0.97)` on pressables. This is the house press, used in more than 70 places. |
| Selected | `--openbot-bg-control-active`, or an accent wash for a persistent selection. |
| Disabled | `opacity: 0.42` with `pointer-events: none`, plus the real `disabled` or `data-disabled` attribute. |
| Loading | `Spinner` or `Skeleton`, and `aria-busy` on the control. `Button` sets it for you when `loading`. |
| Error | `aria-invalid="true"`, which recolors the border to `--openbot-danger`; the message through `Field`; and `t-input.is-error` with the shake recipe when the error has to be noticed. |
| Empty | Say what would be here and what to do about it. A bare "No data" is not an empty state. |

## Responsive behavior

The renderer is a resizable desktop window, not a breakpoint grid.

- Panes flex; the window does not scroll. Anything that can overflow gets its own scroll container.
- Pointer capability, not width, gates hover. Button hover additionally requires `min-width: 601px`, so the
  narrow web playground embeds behave like touch.
- The left panel collapses to its compact 88px rail below the 210px drag threshold and expands again above 220px.
  New sidebar content must have a compact form.
- The server rail narrows to 56px below 800px of window width, and stays 72px on macOS at every size.
- Text truncates with `truncateMiddle` when the tail carries meaning (paths, IDs); otherwise it ellipsizes.
- The landing playground renders the same components inside a web page, so a renderer component must not assume
  Electron APIs exist in order to draw itself.

## Accessibility

- `IconButton` requires `label`. It becomes both `aria-label` and `title`. A `tooltip` may add a shortcut hint; it
  never replaces the label.
- Wrap form controls in `Field`. It generates the `id` and wires `aria-describedby`, `aria-invalid`, and
  `required` from the description and error you pass it. Biome's `noLabelWithoutControl` is an error for `Input`,
  `Textarea`, and `NativeSelect`.
- Use the `complex.tsx` adapters for overlays. They restore focus to the trigger after a dialog, menu, or popover
  closes, which the pinned Kobalte alpha does not do on its own.
- Announce asynchronous change with `role="status"` and `aria-live="polite"`, and label the region. Use `.sr-only`
  for text that only assistive technology needs.
- Every keyboard path must work: tab order, `Escape` to dismiss, arrow keys inside a composite.
- Storybook's accessibility addon is configured to treat violations as errors (`a11y: { test: "error" }` in
  `.storybook/preview.tsx`), and its panel reports them per story. **It is not wired into CI**: the repository
  installs no Storybook test-runner, and the `Storybook build` job only builds. Check the a11y panel by hand for
  every story you touch until a runner exists.

## Do and don't

| Don't | Do |
| --- | --- |
| Write a hex, `rgb()`, or named color in a feature stylesheet or inline style | Use the closest semantic `--openbot-*` token |
| Set a raw pixel font size | Use a `Text` variant or a `Heading` size |
| Add a light theme or a second palette to the renderer | Extend the `:root` tokens for a new semantic role |
| Build a dialog, menu, or tab set from `role=` attributes | Use the `complex.tsx` adapter |
| Import from `@kobalte/core` or `lucide-solid` in a feature | Import from `components/ui` |
| Paste an inline SVG for an icon | Use or add an export in `components/ui/icons.ts` |
| Invent a `z-index` or a new shadow | Use `--openbot-layer-dialog` and the `--openbot-shadow-*` set |
| Remove a focus outline to tidy up a design | Keep `--openbot-focus-ring` |
| Animate for 500ms because it feels smooth | Stay under 300ms and honor `prefers-reduced-motion` |
| Wrap a paragraph in a `Card` with a `Badge` to fill space | Ship the paragraph |
| Duplicate a primitive inside a feature folder | Extend the one in `components/ui` |
| Add a status or warning the app state cannot prove | Say only what the code can support |

## Platforms

**Desktop renderer** — this document. SolidJS, Kobalte behind `components/ui`, hand-authored `.ui-*` and feature
CSS driven by custom properties. Tailwind is installed for its preflight and the `sr-only` utility; it is not the
styling system here, so do not start writing utility-class UI.

**Mobile** — [`apps/mobile/DESIGN.md`](apps/mobile/DESIGN.md) is authoritative. HeroUI Native owns product
content, Expo Router native `Stack`, `NativeTabs`, and `Stack.Toolbar` own navigation chrome, and `@expo/ui` owns
platform controls. Mobile is the one OpenBot surface with light and dark appearance. Its tokens live in
`apps/mobile/global.css` and map HeroUI's semantic aliases onto the OpenBot names used here.

**Landing and auth web** — `apps/auth-api/src/styles.css` carries a trimmed copy of the palette plus web-only
tokens (the hero type size, the glass and hero-grid values) and the `.landing-*` classes.

**Known drift.** The palette is declared three times — the renderer `styles.css`, `apps/mobile/global.css`, and
`apps/auth-api/src/styles.css` — with no shared token package. A brand value added or changed in one must be
mirrored in the others, in the same change. Until that is consolidated, treat any divergence you find as a bug
worth reporting.

## Canonical files

| Path | What it holds |
| --- | --- |
| `src/renderer/src/styles.css` | The `:root` token block. The source of truth. |
| `src/renderer/src/styles/base.css` | Reset and base document roles |
| `src/renderer/src/styles/primitives.css` | The `.ui-*` and `.z-badge-*` component styles |
| `src/renderer/src/styles/transitions.css` | Named motion recipes |
| `src/renderer/src/styles/` | Per-feature stylesheets; no palette lives here |
| `src/renderer/src/components/ui/` | The public component API |
| `src/renderer/src/components/ui/complex.tsx` | Curated Kobalte adapters and focus restoration |
| `src/renderer/src/components/ui/icons.ts` | The Lucide boundary |
| `packages/brand/` | Logos and brand marks |
| `.storybook/preview.tsx` | Storybook decorators and the accessibility gate |
| `scripts/ui-foundation-check.ts` | The mechanical enforcement of this document |
| `scripts/design-contract.ts` | The checks that keep this document and the code in agreement |
| `apps/mobile/DESIGN.md` | The mobile contract |

### Dependency boundary

`@kobalte/core` is pinned exactly at `2.0.0-alpha.0` and reachable only through `components/ui`. Kobalte is a
behavior engine, not OpenBot's public API: the curated adapters in `complex.tsx` keep their export names stable
regardless of upstream restructuring, so an upgrade does not touch features. A local Solid 2 RC compatibility
patch is maintained by Bun in `patches/`; when Kobalte reaches a stable API, remove the patch first and confirm
the wrappers still behave before changing any feature import.

## Verification

| Check | Command | Covers |
| --- | --- | --- |
| Mechanical rules | `bun run check:ui` | Tokens, native controls, import boundaries, and this document's discoverability and inventory |
| Lint and format | `bun run lint` | Biome, including the accessibility rules |
| Unit tests | `bun run test` | Behavior, including the design-contract check's own logic |
| Isolated components | `bun run storybook` | The `Foundations` stories: `Colors`, `Spacing`, `Typography`, `Surface`, `Interactions`, `Forms` |
| Full flows | `bun run dev`, after `bun run dev:seed` for populated state | App shell, conversation, composer, dialogs, menus |

`bun run check:ui` runs inside `bun run check:desktop`, which CI runs on every pull request.

Verify a component in Storybook and a flow in the dev app. Never verify UI from `dist/`, a packaged `.app`, or a
production build. For each component you touch, confirm default, hover, focus-visible, active, disabled, and
loading or empty where they apply, plus the keyboard path and the Storybook accessibility panel — nothing in CI
runs that panel for you.

Follow the repository test policy in [`AGENTS.md`](AGENTS.md): do not write tests that assert CSS classes, DOM
structure, variants, spacing, or hover appearance. Those are Storybook's job.

## Maintaining this document

`design.md` is versioned with the code and changes in the same pull request as the code it describes.

- **Adding a token** — declare it in the `:root` block of `src/renderer/src/styles.css`, add it to the relevant
  table here, and mirror it in `apps/mobile/global.css` and `apps/auth-api/src/styles.css` if it is a brand
  value. `check:ui` fails if this document names a token that `:root` does not declare, if any renderer
  stylesheet or inline style uses an `--openbot-*` property that `:root` does not declare, and if a token table
  row above quotes a literal value that no longer matches the declaration.
- **Adding a component** — build it in `components/ui`, export it from `index.ts`, add its row to the inventory
  table, and add it to "Which component do I pick" if it changes a decision. `check:ui` fails if a barrel module
  is missing from the inventory, and if a module exports a runtime name — a `const`, `function`, `class`, or
  local `export { name }` — that its own inventory row does not list, so a new export on an existing module has
  to be documented too. Prop and type exports are implementation detail and are deliberately not inventoried;
  a row names a type only when picking it is a real decision, like `TextVariant` or `ControlSize`.
- **Changing a layout number** — the numbers this document states in prose are pinned to the constants that own
  them (`LEFT_PANEL_*` in `src/renderer/src/App.tsx`, the rail and header custom properties in
  `styles/app-shell.css`, the bubble measure in `styles/primitives.css`). `check:ui` derives the expected
  sentence from the live value, so changing a constant without updating the prose fails.
- **Changing a rule** — change the prose here, and if the rule can be checked deterministically, add it to
  `scripts/ui-foundation-check.ts` or `scripts/design-contract.ts` in the same change. Prose is for judgment;
  mechanics belong in the check.
- **Removing a rule** — delete it here and delete its check. A rule nobody enforces and nobody follows is worse
  than no rule.

When a review keeps correcting the same thing, that correction belongs in this file — or, better, in the check.
