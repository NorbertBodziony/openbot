# Releasing OpenBot

OpenBot updates are published through GitHub Releases and installed with `electron-updater`.
macOS requires every auto-updatable build to be signed with a Developer ID Application certificate.
The release workflow also notarizes and staples the application before publishing it.

## One-time GitHub setup

Create the `release` environment in `NorbertBodziony/openbot`, then add these environment secrets:

- `CSC_LINK` — a base64-encoded Developer ID Application `.p12` file.
- `CSC_KEY_PASSWORD` — the `.p12` export password.
- `APPLE_ID` — the Apple Account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD` — a dedicated app-specific password for `notarytool`.
- `APPLE_TEAM_ID` — the Apple Developer team ID.

Do not use an Apple Development certificate. Direct distribution and native macOS updates require a
Developer ID Application certificate. Never commit signing credentials to the repository.

## Publish a version

Start from a clean, up-to-date `main` branch. For the first release, `package.json` and
`CHANGELOG.md` are already prepared as `0.1.0`; after CI passes, create its annotated tag directly:

```bash
git tag -a v0.1.0 -m "OpenBot v0.1.0"
git push origin v0.1.0
```

For later releases, add the release notes under `Unreleased`, then choose the appropriate semantic
version bump:

```bash
bun run release:patch
# or: bun run release:minor
# or: bun run release:major
```

The command updates `package.json` and moves the unreleased changelog entries under the new dated
version heading. Review and publish that preparation before creating the tag:

```bash
git add package.json CHANGELOG.md
git commit -m "release: prepare vX.Y.Z"
git push origin main
bun run release:preflight
git tag -a vX.Y.Z -m "OpenBot vX.Y.Z"
git push origin vX.Y.Z
```

Pushing the version tag runs `.github/workflows/release.yml`.

The workflow:

1. verifies the tag matches `package.json`;
2. runs the complete offline repository check;
3. builds signed and notarized ARM64 DMG and ZIP artifacts without publishing them early;
4. verifies the signature, notarization ticket, and `latest-mac.yml`;
5. generates an SPDX SBOM and records GitHub build-provenance attestations for the DMG and ZIP;
6. publishes a non-draft GitHub Release with checksums, SBOM, and update metadata.

Users can verify a downloaded artifact with
`gh attestation verify <file> --repo NorbertBodziony/openbot`.

Installed OpenBot builds check for updates shortly after launch and every four hours. Updates are
never downloaded without a user action. The account popover shows the current state and lets the user
download an available version, then restart into it.

If a release is bad, publish a newer patch version. Do not replace an already published version with
different binaries.

## Preflight checklist

Before creating the first tag or any later release:

1. run `bun run release:preflight` and resolve every reported signing or repository gate;
2. confirm the `release` environment contains all five secrets above;
3. run `bun install --frozen-lockfile` and `bun run check` from a clean clone;
4. run `bun run package:verify` and launch the generated `dist/mac-arm64/OpenBot.app`;
5. smoke-test sign-in/setup, chat streaming, queues, attachments, agent messaging, browser control,
   context compaction, and the update popover;
6. confirm `CHANGELOG.md` describes the version and the working tree is clean;
7. create and push the version commit and tag only after CI passes on `main`.

The unsigned local package is a development artifact. It does not prove Gatekeeper, notarization,
or auto-update readiness. Those are proven only by the signed release workflow's `codesign`, `spctl`,
and `stapler` checks.

After publishing `v0.1.0`, keep one installed copy and use the first signed patch (`v0.1.1`) as the
end-to-end updater acceptance test: check, download, restart, and confirm the version changed without
losing local agents or queues. This cannot be proven with an unsigned development build because macOS
updaters require both versions to share a valid Developer ID signature.
