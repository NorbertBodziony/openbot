# Repository guidance

## Design system

- Read [`design.md`](design.md) before you create or change any UI. It is the visual and interaction contract for OpenBot: brand direction, tokens, the `components/ui` public API, interaction states, responsive behavior, accessibility, and motion. It is required reading, not background material.
- For mobile UI, read [`apps/mobile/DESIGN.md`](apps/mobile/DESIGN.md) first for component ownership, then `design.md` for brand, tokens, and motion.
- Follow the component reuse order in `design.md`: search this repository, then the [Zaidan catalog](https://zaidan.carere.dev/docs/components), then build in `src/renderer/src/components/ui` and use it from the feature. Never copy a shared primitive into a feature component.
- `bun run check:ui` enforces the mechanical half of `design.md` and runs in CI. When you add a token or a component, update `design.md` in the same change, or the check fails.
- When a review keeps correcting the same UI decision, put the correction in `design.md`, or in `scripts/design-contract.ts` when it can be checked deterministically.

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

- Add or update a Storybook story when a shared component gains a visual or interactive state that Storybook can verify.
- Only create a component from scratch after the repository and Zaidan searches do not provide a suitable base. Keep it reusable when the same UI pattern can reasonably appear again.

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
