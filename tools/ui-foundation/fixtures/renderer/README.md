# ui-foundation fixture

A miniature `src/renderer/src` that breaks every check in `scripts/ui-foundation-check.ts`
exactly once, beside correct code each check must leave alone. `scripts/ui-foundation-check.test.ts`
asserts the resulting report line for line, so a check that stops matching turns red here instead of
staying green in CI.

Nothing here is compiled, linted or rendered — `biome.json` excludes the directory and no tsconfig
includes it. Treat every file as data read by the test.

Adding a check to the script means adding both halves to this tree: the file that trips it, and the
neighbour it must ignore.
