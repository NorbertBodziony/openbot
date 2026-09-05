# ui-foundation fixture

A miniature `src/renderer/src` that breaks every check in `scripts/ui-foundation-check.ts`,
beside correct code each check must leave alone. Where a check names two things that can break
independently - `@kobalte/core` and `lucide-solid`, a hex colour and a named one - each gets its
own line here, because one of them firing says nothing about the other. `scripts/ui-foundation-check.test.ts`
asserts the resulting report line for line, so a check that stops matching turns red here instead of
staying green in CI.

Nothing here is compiled, linted or rendered — `biome.json` excludes the directory and no tsconfig
includes it. Treat every file as data read by the test.

`components/ui-kit` is not a typo: it is the neighbour that proves skipping the design system
compares a path prefix against a separator rather than against `components/ui` alone.

Adding a check to the script means adding both halves to this tree: the file that trips it, and the
neighbour it must ignore.
