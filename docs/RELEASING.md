# Releasing OpenBot

OpenBot updates are published through GitHub Releases and installed with `electron-updater`.
macOS requires every auto-updatable build to be signed with a Developer ID Application certificate.
The release workflow also notarizes and staples the application before publishing it. Windows x64
builds use an unsigned NSIS installer for now. GitHub Actions builds both platforms; release packages
are not built on a developer machine.

## One-time GitHub setup

Create the `release` environment in `NorbertBodziony/openbot`, then add these environment secrets:

- `CSC_LINK` — a base64-encoded Developer ID Application `.p12` file.
- `CSC_KEY_PASSWORD` — the `.p12` export password.
- `APPLE_ID` — the Apple Account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD` — a dedicated app-specific password for `notarytool`.
- `APPLE_TEAM_ID` — the Apple Developer team ID.

Do not use an Apple Development certificate. Direct distribution and native macOS updates require a
Developer ID Application certificate. Never commit signing credentials to the repository.

Windows does not need a signing secret in the current workflow. The workflow requires the generated
installer to have the `NotSigned` Authenticode state. This makes an unexpected signing configuration
fail before publication. Users can see an `Unknown publisher` or SmartScreen warning. Add Windows
signing later with Azure Artifact Signing or a suitable Authenticode certificate, and then remove the
explicit unsigned checks from `electron-builder.yml` and the release workflow.

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
3. builds signed and notarized ARM64 DMG and ZIP artifacts on a GitHub macOS runner;
4. builds an unsigned Windows x64 NSIS installer on a GitHub Windows runner;
5. verifies each unpacked application, update metadata, and the expected signing state;
6. generates platform SPDX SBOMs and GitHub build-provenance attestations;
7. publishes one non-draft GitHub Release only after both platform jobs pass.

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
5. confirm that the Windows x64 job passes on `main`; it builds and launches the Windows package on
   a GitHub-hosted Windows runner;
6. smoke-test sign-in/setup, chat streaming, queues, attachments, agent messaging, browser control,
   context compaction, and the update popover;
7. confirm `CHANGELOG.md` describes the version and the working tree is clean;
8. create and push the version commit and tag only after CI passes on `main`.

The unsigned local macOS package is a development artifact. It does not prove Gatekeeper,
notarization, or auto-update readiness. Those are proven only by the signed release workflow's
`codesign`, `spctl`, and `stapler` checks. The Windows package stays unsigned until Windows signing is
configured. Its SHA-256 checksum and GitHub build attestation prove which GitHub workflow built the
file, but they do not remove the Windows publisher warning.

After publishing `v0.1.0`, keep one installed copy and use the first signed patch (`v0.1.1`) as the
end-to-end updater acceptance test: check, download, restart, and confirm the version changed without
losing local agents or queues. This cannot be proven with an unsigned development build because macOS
updaters require both versions to share a valid Developer ID signature.
