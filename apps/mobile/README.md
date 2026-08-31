# OpenBot Mobile

React Native app built with Expo SDK 57, Expo Router, TypeScript, and Bun. The app uses Expo Continuous Native Generation, so native `ios/` and `android/` directories are intentionally not committed.

## Requirements

- Node.js 22.13 or newer (an active LTS release is recommended)
- Bun 1.3 or newer
- Expo Go for basic device testing, or an EAS development build for the full native environment

## Development

Run commands from the repository root:

```bash
bun run mobile
bun run mobile:ios
bun run mobile:android
bun run mobile:web
```

Application routes live in `src/app`. Shared components, hooks, and other application code live in sibling directories under `src`.

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
