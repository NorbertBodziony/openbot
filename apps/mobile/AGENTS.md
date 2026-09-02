This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Execution and verification limits

- Never run any build, packaging, signing, submission, or deployment command for the mobile app unless the user gives explicit permission for that specific command.
- Never start an iOS simulator, Android emulator, device run, or native development client unless the user gives explicit permission for that specific run.
- Do not run wide or full-repository checks by default. The allowed default checks are lint, Biome, and TypeScript checks limited to files changed by the task.
- Before creating or executing a PR, wider checks are required. If they have not been run, stop before the PR and request explicit permission for each concrete wider check that must be run.
- Permission for a wider check authorizes only the one named check or command. It does not authorize other wider checks, builds, simulator/emulator runs, or subsequent commands.
- If a requested workflow would require a prohibited command, explain the limitation and wait for explicit permission rather than substituting a broader command or running it implicitly.

## Design system and native chrome

Read and follow [`DESIGN.md`](./DESIGN.md) before changing mobile UI.

- Build application content with HeroUI Native. Reuse its installed components and the OpenBot theme aliases in `global.css`; do not introduce a parallel component library, theme, or screen-local design language.
- HeroUI-first does not mean component-heavy. Prefer the smallest composition that communicates the screen: plain layout plus `Typography` and `Button` is better than decorative `Card`, `Chip`, `Surface`, or `Alert` wrappers when those components add no interaction or hierarchy.
- Render product text with HeroUI Native `Typography` and its semantic variants. Do not import React Native `Text` directly in screens or product components unless an integration boundary explicitly requires the native primitive.
- Treat system chrome as the deliberate exception to the HeroUI-first rule. Navigation stacks, headers, tab bars, toolbars, search bars, system menus, and route-level sheets must use the native Expo Router or `@expo/ui` APIs whenever they provide the required behavior.
- Prefer `Stack`, `Stack.Title`, `Stack.Toolbar`, `Stack.SearchBar`, and `NativeTabs` over custom React Native or HeroUI imitations. Native chrome must remain native so iOS can provide Liquid Glass on supported versions and Android can use its platform conventions.
- Do not fake native chrome with custom blur, gradients, translucent cards, or `GlassView`. Use `expo-glass-effect` only for an intentional custom in-content glass surface, with platform and accessibility fallbacks.
- If neither an existing OpenBot component nor HeroUI Native fits an application-content need, verify that before creating a reusable component. If native APIs cannot satisfy a system-chrome requirement, document the constraint in the change before using a fallback.
- Do not add status badges, warnings, or operational guidance unless the application state and repository behavior support the claim. Verify lifecycle and connectivity copy against the implementation before presenting it to users.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
bunx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
bun run start                # start the dev server
bun run lint                 # lint and format-check with Biome
bun run typecheck            # typecheck with TypeScript 7
bun run doctor               # diagnose dependency and config issues
bunx expo install --fix      # fix incompatible package versions
```

The `lint` and `typecheck` examples are permitted only when scoped to files changed by the task; do not run a repository-wide script as-is when it checks unrelated files.

Before declaring any task done, run only targeted lint, Biome, and TypeScript checks covering the files changed by the task.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS (explicit authorization only)

EAS build, signing, submission, and update commands are prohibited unless the user explicitly authorizes that exact command. If authorized, use EAS to perform the requested operation in the cloud (`eas build`, `eas submit`, or `eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build; do not create or run one without explicit user authorization for the exact build or run command.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
