# OpenBot Mobile

React Native app built with Expo SDK 57, Expo Router, TypeScript 7, Biome, and Bun. The app uses Expo Continuous Native Generation, so native `ios/` and `android/` directories are intentionally not committed.

## Requirements

- Node.js 24 or newer (the repository pins 24 in `.nvmrc`)
- Bun 1.3 or newer
- Expo Go for device testing, including the WebRTC server connection

## Development

Run commands from the repository root:

```bash
bun run mobile
bun run mobile:ios
bun run mobile:android
```

For an Expo Go device outside the computer's trusted local network context, start Metro with a secure
tunnel:

```bash
bun run mobile -- --tunnel
```

The native UI does not depend on a native WebRTC module. A hidden Expo DOM component owns the browser
`RTCPeerConnection` and its authenticated DataChannels, then forwards validated commands and live
events to React Native. This keeps the production transport identical while remaining testable in
Expo Go without a development build.

## Source structure

The mobile app uses a feature-first structure. Expo Router files stay deliberately thin: `src/app`
defines URLs, route groups, guards, and navigator options, while screen implementations live with
the feature that owns them.

```text
src/
  app/                  Expo Router routes and layouts only
    (app)/              routes available to an authenticated session
  features/
    auth/               QR sign-in, session storage, and session context
    bots/               bot list, bot actions, and pin transitions
    chat/               chat screen and its focused UI sections
    search/             search model, controls, results, and screen
    servers/            server drawer and joining a server
    settings/           account settings screen
    workspace/          remote directory, WebRTC transport, live events, and workspace state
  shared/
    components/         UI used by more than one feature
    lib/                platform and infrastructure helpers
```

Keep code inside a feature until a second feature needs it. Move it to `shared` only when it has no
feature-specific behavior. Shared code must not import from features; direct feature-to-feature reuse
should stay explicit so it cannot turn into an accidental circular dependency.
Split screens into focused sections when they combine navigation, local state, and multiple distinct
UI regions; for example, chat owns separate header, message-list, and composer components.

## Design development

The mobile design system is documented in [`DESIGN.md`](./DESIGN.md). Read it before implementing or reviewing UI.

In short, use HeroUI Native for application content and reusable product components. Use native Expo Router and `@expo/ui` surfaces for navigation, headers, tabs, toolbars, search, menus, and route-level sheets so each platform owns its chrome and iOS can render Liquid Glass where the operating system supports it.

## Verification

```bash
bun run mobile:lint
bun run mobile:typecheck
bun run mobile:doctor
```

## EAS

The project is linked to EAS and has development, preview, and production build profiles in `eas.json`.

```bash
cd apps/mobile
bunx eas-cli@latest build --profile development --platform ios
bunx eas-cli@latest build --profile development --platform android
```

Cloud builds require the final `ios.bundleIdentifier` and `android.package` values in `app.json`. Store submission also requires Apple Developer and Google Play Console credentials.
