# Releasing OpenBot

OpenBot updates are published through GitHub Releases and installed with `electron-updater`.
macOS requires every auto-updatable build to be signed with a Developer ID Application certificate.
The release workflow also notarizes and staples the application before publishing it.

## One-time GitHub setup

Create the `release` environment in `NorbertBodziony/openbot`, then add these environment secrets:

- `CSC_LINK` — a base64-encoded Developer ID Application `.p12` file.
- `CSC_KEY_PASSWORD` — the `.p12` export password.
- `APPLE_API_KEY_BASE64` — a base64-encoded App Store Connect API `.p8` key.
- `APPLE_API_KEY_ID` — the API key ID.
- `APPLE_API_ISSUER` — the API issuer ID.

Do not use an Apple Development certificate. Direct distribution and native macOS updates require a
Developer ID Application certificate. Never commit signing credentials to the repository.

## Publish a version

Start from a clean, up-to-date `main` branch. Choose the appropriate semantic version bump:

```bash
bun run release:patch
# or: bun run release:minor
# or: bun run release:major
git push origin main --follow-tags
```

`bun pm version` updates `package.json`, creates the version commit, and creates the matching `vX.Y.Z`
tag. Pushing the tag runs `.github/workflows/release.yml`.

The workflow:

1. verifies the tag matches `package.json`;
2. runs the complete offline repository check;
3. builds signed and notarized ARM64 DMG and ZIP artifacts;
4. verifies the signature, notarization ticket, and `latest-mac.yml`;
5. records GitHub build-provenance attestations for the DMG and ZIP;
6. publishes a non-draft GitHub Release with checksums and update metadata.

Users can verify a downloaded artifact with
`gh attestation verify <file> --repo NorbertBodziony/openbot`.

Installed OpenBot builds check for updates shortly after launch and every four hours. Updates are
never downloaded without a user action. The account popover shows the current state and lets the user
download an available version, then restart into it.

If a release is bad, publish a newer patch version. Do not replace an already published version with
different binaries.

## Preflight checklist

Before creating the first tag or any later release:

1. confirm the `release` environment contains all five secrets above;
2. run `bun install --frozen-lockfile` and `bun run check` from a clean clone;
3. run `bun run package:verify` and launch the generated `dist/mac-arm64/OpenBot.app`;
4. smoke-test sign-in/setup, chat streaming, queues, attachments, agent messaging, browser control,
   context compaction, and the update popover;
5. confirm `CHANGELOG.md` describes the version and the working tree is clean;
6. create and push the version commit and tag only after CI passes on `main`.

The unsigned local package is a development artifact. It does not prove Gatekeeper, notarization,
or auto-update readiness. Those are proven only by the signed release workflow's `codesign`, `spctl`,
and `stapler` checks.
