# Repository guidance

## Renderer UI

- For integrated renderer UI work, always use `bun run dev`. This starts the local Auth API and the Electron dev app together.
- When multiple agents work at the same time, reuse one shared `bun run dev` instance when possible. Do not start competing dev stacks for the same profile and default ports.
- Do not start the API and Electron app separately unless the task requires isolated service debugging. Use `bun run dev:api` only for API-only debugging.
- Use `bun run storybook` to verify isolated components.
- Never use `dist/`, packaged `.app` files, production builds, or ad-hoc previews for UI verification.
- If the dev app does not start, stop and report the blocker. Do not fall back to a packaged app.
- Use packaged apps only when the user explicitly requests release or package verification.
- For a populated integrated UI, stop the dev app, run `bun run dev:seed`, then run `bun run dev`. Use `bun run dev:seed --dry-run` to inspect the seed without changing local state.
- Before adding or changing UI code, search for reusable components, hooks, styles, and utilities. Prefer reuse, composition, or a small extension; add new code only when the existing code does not fit or would reduce clarity.
- Treat the `:root` properties in `src/renderer/src/styles.css` as the renderer color palette. Use the closest semantic `--openbot-*` token, including opacity variants, instead of ad-hoc color literals. Add a token there only for a new semantic role. Keep existing compatibility aliases when used, and isolate fixed integration, generated asset, SVG, or platform colors at their boundaries.
