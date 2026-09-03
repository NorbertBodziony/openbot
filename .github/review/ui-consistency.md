---
include:
  - "src/renderer/**"
  - ".storybook/**"
---

## Renderer UI review

The renderer is SolidJS 2 RC over patched Kobalte 2 alpha. Judge the diff against what this
repository actually does, not against React or shadcn habits.

Report a finding when the diff:

- Introduces a colour literal where a semantic `--openbot-*` token from `src/renderer/src/styles.css`
  exists. *Exception:* fixed integration colours, generated assets, inline SVG payloads, and platform
  chrome are allowed to carry literals at their boundary.
- Adds a token to one palette only. `--openbot-*` is declared separately in
  `src/renderer/src/styles.css`, `apps/auth-api/src/styles.css`, and `apps/mobile/global.css`. Flag
  this only when the change plainly needs the token on more than one surface.
- Adds an inline SVG or a local icon component where a `lucide-solid` icon exists, without a comment
  explaining why Lucide does not fit.
- Duplicates a primitive that already exists in `src/renderer/src/components/ui`, or copies a shared
  primitive into a feature component instead of extending the shared one.
- Changes an IPC-facing renderer surface without the matching update to
  `src/renderer/src/preview/mock-openbot.ts`, which Storybook and the preview run against.
- Adds a state a user can enter but not leave — a snooze with no unsnooze, a pause with no resume.

Do **not** report:

- Raw elements that intentionally implement a semantic row, tab, resize handle, or other pattern the
  component library does not cover. This is a deliberate choice here, not an oversight.
- A missing Storybook story for a component with no visual or interactive state to verify.
- A missing test for markup, classes, layout, animation timing, or focus placement. `AGENTS.md`
  "Tests" forbids those, and Biome rejects the matching assertions.
- Requests to widen a component's contract beyond what the design system deliberately promises. A
  narrow prop surface is the intent.
- Accessibility findings based only on where focus lands. Accessible role, name, and announcement are
  the contract.
