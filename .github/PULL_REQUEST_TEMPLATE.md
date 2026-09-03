## What changed

<!-- Describe the user-visible outcome and why this is the smallest useful change. -->

## Verification

- [ ] Narrow checks for what changed: `biome check <paths>`, a targeted `tsc`, and the affected test files — CI owns the full suite
- [ ] Surfaces touched are named under "What changed": renderer, mobile, `apps/auth-api`, the three `--openbot-*` palettes, IPC contracts and `mock-openbot.ts`, reverse states, migrations and the latest schema, documentation
- [ ] Relevant manual smoke test completed, or not applicable
- [ ] No credentials, private data, generated output, or real user files are included

## Risk and security impact

<!-- Note changes to permissions, IPC, filesystem access, persistence, browser behavior, or network access. Write "None" when not applicable. -->

## Screenshots

<!-- Include before/after screenshots for visual changes. Remove this section when not applicable. -->

## Approvability

<!-- Remove this section unless the PR adds a `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, a rule-disabling `biome.json` override, or a widening to `any`/`unknown` or a type assertion at a boundary. Otherwise name the reason each one is there. -->
