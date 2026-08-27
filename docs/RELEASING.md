# Releasing OpenBot

OpenBot updates are published through GitHub Releases and installed with `electron-updater`.
macOS requires every auto-updatable build to be signed with a Developer ID Application certificate.
The release workflow also notarizes and staples the macOS application before publishing it. Windows
x64 releases are currently unsigned, so Windows can show an Unknown publisher or SmartScreen warning.
Both platforms must pass before one release is published. A release also requires the pinned Sunshine
and Moonlight Web runtime artifacts. GitHub Actions downloads those artifacts, checks SHA-256, and
verifies their native executables as part of the final OpenBot package. Release packages are not built
on a developer machine.

## One-time GitHub setup

Create the `release` environment in `NorbertBodziony/openbot`, then add these environment secrets:

- `CSC_LINK` — a base64-encoded Developer ID Application `.p12` file.
- `MAC_PROVISIONING_PROFILE` — the base64-encoded Developer ID provisioning profile for
  `app.openbot.desktop`, with the `applinks:openbot.run` entitlement.
- `CSC_KEY_PASSWORD` — the `.p12` export password.
- `APPLE_ID` — the Apple Account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD` — a dedicated app-specific password for `notarytool`.
- `APPLE_TEAM_ID` — the Apple Developer team ID.

Do not use an Apple Development certificate. Direct distribution and native macOS updates require a
Developer ID Application certificate. Never commit signing credentials to the repository.

Windows signing credentials are not currently configured. The workflow explicitly verifies that the
OpenBot executable and NSIS installer remain unsigned, while retaining package, runtime, updater,
checksum, SBOM, and provenance checks.

## Build the remote desktop runtime

`native-runtime.lock.json` pins the OpenBot forks of Sunshine `v2026.516.143833` and Moonlight Web
`v2.10.0` by full commit and source archive SHA-256. Each entry also records its exact upstream base
commit and the reviewable OpenBot patch. Build on the target platform:

```bash
bun run build:remote-desktop-runtime
bun run verify:remote-desktop-runtime
```

The command writes binaries, the static Moonlight viewer, GPL-3.0 licenses, corresponding-source
metadata, and SHA-256 checksums under `build/remote-desktop-runtime/<platform>/<arch>`. Publish the
exact corresponding source for both GPL components with every binary release. A release must stop if
a binary, license, source manifest, checksum, platform signature, or notarization result is missing.

Use this source build only to make or reproduce a runtime version. The
`.github/workflows/remote-desktop-runtime.yml` workflow builds macOS ARM64 and Windows x64 when the
recipe or a pinned input changes. It publishes an immutable GitHub prerelease named
`remote-desktop-runtime-<input-digest>`. The prerelease contains both deterministic archives, SPDX
SBOMs, build provenance, and `remote-desktop-runtime-manifest.json`. It is not an OpenBot application
update and it must never contain `latest.yml`.

After publication, the workflow opens a draft PR that adds the release tag and SHA-256 values to
`native-runtime.lock.json`. Normal CI and application release jobs then use:

```bash
bun run install:remote-desktop-runtime
bun run verify:remote-desktop-runtime
```

The installer accepts only the exact prerelease and assets in the lock file. It rejects a changed
manifest, a changed archive, an unsafe archive path, and a mismatched source manifest. Do not replace
assets in an existing runtime prerelease. Increase `recipeVersion` when the build process changes.

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
The tag workflow starts only after `https://openbot.run/join` and the Apple association file return
direct `200` responses with the required security headers, MIME type, app ID, and `/join` scope.

The workflow:

1. verifies the tag matches `package.json`;
2. installs and verifies the pinned remote desktop runtime without CMake or Cargo;
3. runs the complete offline repository check;
4. builds signed and notarized ARM64 DMG and ZIP artifacts on a GitHub macOS runner;
5. builds an unsigned Windows x64 NSIS installer on a GitHub Windows runner;
6. verifies both unpacked applications, update metadata, runtimes, licenses, checksums, platform
   signing contracts, launch behavior, and update artifact size limits;
7. generates SPDX SBOMs and GitHub build-provenance attestations for both platforms;
8. publishes one non-draft GitHub Release only after both platform jobs pass.

Users can verify a downloaded artifact with
`gh attestation verify <file> --repo NorbertBodziony/openbot`.

Installed OpenBot builds check for updates shortly after launch and every four hours. Updates are
never downloaded without a user action. The account popover shows the current state and lets the user
download an available version, then restart into it. macOS shows the restart action only after the
native updater finishes staging the ZIP. Windows installs only after the explicit restart action.

The Whisper executable is part of the application. The `ggml-medium-q5_0.bin` model is not part of an
application or update artifact. OpenBot downloads the pinned model on first voice use, checks its size
and SHA-256, and keeps the verified file in the user data directory for later offline use.

The release workflow stops if the macOS update ZIP or Windows NSIS installer is larger than 700 MiB,
or if the DMG is larger than 750 MiB. It also stops if update metadata has a wrong size or SHA-512, if
the Whisper model is present, or if the application contains a second native Claude runtime.

If a release is bad, publish a newer patch version. Do not replace an already published version with
different binaries.

## Preflight checklist

Before creating the first tag or any later release:

1. run `bun run release:preflight` and resolve every reported release-secret or repository gate;
2. confirm the `release` environment contains all six macOS secrets above; Windows remains unsigned;
3. confirm the production `/join` page and Apple association file pass the deployment checks in CI;
4. run `bun install --frozen-lockfile` and `bun run check` from a clean clone;
5. run `bun run package:verify` on macOS; Windows packaging and launch verification run on the release
   runner;
6. confirm that the lock file contains both runtime artifacts and that their install checks pass;
7. smoke-test sign-in/setup, chat streaming, queues, attachments, agent messaging, browser control,
   context compaction, and the update popover;
8. on macOS ARM64 and Windows x64, update from the last public version and confirm check, download,
   preparation, explicit restart, new version, local agents, conversations, and queues;
9. test first voice use, download progress, retry after a stopped download, transcription, and cached
   offline use;
10. confirm `CHANGELOG.md` describes the version and the working tree is clean;
11. create and push the version commit and tag only after CI passes on `main`.

The unsigned local macOS package is a development artifact. It does not prove Gatekeeper,
notarization, or auto-update readiness. Those are proven only by the signed release workflow's
`codesign`, `spctl`, and `stapler` checks.

After publishing `v0.1.0`, keep one installed copy and use the first signed patch (`v0.1.1`) as the
end-to-end updater acceptance test: check, download, restart, and confirm the version changed without
losing local agents or queues. This cannot be proven with an unsigned development build because macOS
updaters require both versions to share a valid Developer ID signature.
