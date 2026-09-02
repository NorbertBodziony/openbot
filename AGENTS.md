# Repository guidance

## Renderer UI

- For integrated renderer UI work, always use `bun run dev`. This starts the local Auth API and the Electron dev app together.
- When multiple agents work at the same time, reuse one shared `bun run dev` instance when possible. Do not start competing dev stacks for the same profile and default ports.
- Do not start the API and Electron app separately unless the task requires isolated service debugging. Use `bun run dev:api` only for API-only debugging.
- Use `bun run storybook` to verify isolated components.
- Do not run `bun run build-storybook` for routine development, UI verification, or tests. Use the running Storybook instance and targeted tests instead. Run `bun run build-storybook` only when the user explicitly requests it or when release or CI verification requires it.
- Never use `dist/`, packaged `.app` files, production builds, or ad-hoc previews for UI verification.
- If the dev app does not start, stop and report the blocker. Do not fall back to a packaged app.
- Use packaged apps only when the user explicitly requests release or package verification.
- For a populated integrated UI, stop the dev app, run `bun run dev:seed`, then run `bun run dev`. Use `bun run dev:seed --dry-run` to inspect the seed without changing local state.

### Component reuse workflow

- Before you add or change UI code, search the repository for reusable components, hooks, styles, utilities, and Storybook stories. Prefer reuse, composition, or a small extension of an existing component.
- If no existing component fits, search the [Zaidan component catalog](https://zaidan.carere.dev/docs/components) for the same component or a close match before you design or implement a component from scratch.
- If Zaidan has a suitable component, use its source as the starting point. Adapt it to this repository's SolidJS conventions, renderer color tokens, typography, spacing, icons, accessibility requirements, and component API.
- Create or extend the reusable repository component in `src/renderer/src/components/ui` before you use it in a feature. Do not copy a shared primitive directly into a feature component.
- Add or update its Storybook story when the shared component has a visual or interactive state that Storybook can verify.
- Only create a component from scratch after the repository and Zaidan searches do not provide a suitable base. Keep it reusable when the same UI pattern can reasonably appear again.
- Use the shared component in the feature only after the reusable component layer is ready.

- Use `lucide-solid` for renderer UI icons. Reuse a suitable Lucide icon before you add an inline SVG or a local icon component. Add a custom icon only when Lucide has no suitable icon, and document the exception next to the custom icon.
- Treat the `:root` properties in `src/renderer/src/styles.css` as the renderer color palette. Use the closest semantic `--openbot-*` token, including opacity variants, instead of ad-hoc color literals. Add a token there only for a new semantic role. Keep existing compatibility aliases when used, and isolate fixed integration, generated asset, SVG, or platform colors at their boundaries.

## Database migrations

- OpenBot does not create an automatic full copy of `openbot.db` before upgrading. Treat every migration as an irreversible production data operation: preserve all user data, support every shipped source schema, and never depend on a backup being available.
- Keep each schema change and its `schema_migrations` marker in the same transaction. Roll back on any error, restore foreign-key enforcement in `finally`, and run the integrity checks before allowing startup to continue.
- Never edit or delete a migration that may have shipped, including the frozen version 8 baseline. Append the next contiguous version and update the separate latest schema used for new databases.
- Migration changes require data-preservation fixtures for every affected released schema plus failure, rollback, retry, downgrade, missing-version, foreign-key, and integrity coverage at the stable database boundary.
- Do not add automatic full-database migration backups. Their time and disk cost is unbounded because conversation history lives in SQLite; make the migration itself safe instead.

## Team API protocol compatibility

- Never use the OpenBot application SemVer as a wire protocol version. Application versions are diagnostic metadata only.
- Keep a frozen codec, adapter, and client and host fixtures for each released Team API protocol under `packages/contracts/src/team-protocol`.
- Keep one registered adapter for every supported protocol. Do not serialize current IPC types directly across the Team API boundary.
- Use capabilities for additive, optional behavior. A missing capability can disable only the related feature.
- Add a new protocol version for a required field, a removed field, or a semantic change. Never change the meaning of a released protocol.
- Do not remove an adapter because of age, release count, or SemVer distance. Removal requires a separate architecture decision for a security issue, data-loss risk, semantics that cannot be kept, or cost that an adapter cannot contain. Also add a changelog entry, update instructions, both update-direction tests, and clear UI text.
- Keep malformed known payloads fail-closed as `protocol_error`. Ignore unknown optional events.

## Test value policy

- Keep verification minimal and proportional to the change. Run the narrowest relevant automated test and, when needed, one manual UI check; do not repeat equivalent checks across Vitest, Storybook, and the integrated app unless they cover genuinely different runtime behavior.
- Write tests only when they protect user behavior, accessibility, data integrity, security or permission boundaries, IPC contracts, persistence, error recovery, asynchronous ordering, or a reproduced regression.
- Do not add tests that only check static text, CSS classes, visual-only data attributes, DOM structure, component variants, sizes, layout, animation timing, hover appearance, or Storybook states. Verify visual details in Storybook or with `bun run dev`.
- Tests can use accessible roles and names to find controls. Assert the action and its result, not the exact wording. Assert exact text only when the text is a product contract, an error or security message, serialized output, or a localization key.
- Do not test the same rule at the component and application levels. Prefer one test at the lowest stable behavior boundary. Keep only one application-level happy path when it protects a critical integration.
- A UI test must fail when behavior or accessibility breaks. It must not fail only because markup, wording, or styling changes.
- For a bug fix, add a regression test only when it reproduces the failure at a stable boundary and can prevent the same failure from returning.
- The default answer is no test. A test is an exception that must name the consequence it protects.
- Before writing a test, check whether `tsc`, Biome and its GritQL rules, `bun run check:ui`, or Storybook already enforces the rule. If one of them does, do not write the test.
- Put pure logic in the vitest `node` project even when the module lives in the renderer.
- A test is mandatory when a change touches the renderer-to-main trust boundary, the IPC contract, database schema or migrations, persisted state, secrets, the provider process boundary, the Team API wire protocol, or the updater. Read `docs/TESTING.md` before writing it.
- `src/renderer/src/App.test.tsx` is closed to new cases. New coverage goes to a module or to a component test at the lowest stable boundary.
