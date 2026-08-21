# Changelog

All notable changes to OpenBot will be documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.12] - 2026-08-22

### Added

- Add full-window P2P Remote Control for active server members, with shared mouse and keyboard control,
  four concurrent sessions, monitor selection, hide and resume, retry, and explicit disconnect.
- Bundle pinned Sunshine and Moonlight Web runtimes built from source, with immutable artifacts,
  corresponding GPL source, checksums, SBOMs, and build provenance.
- Add speech-to-text message input with local Whisper model preparation.
- Add universal server invitation links and updated account, server, queue, attachment, and conversation
  controls.

### Changed

- Changed the project license from Apache-2.0 to PolyForm Noncommercial 1.0.0.
- Publish the OpenBot application for macOS only in this release while Windows application packaging is
  paused.
- Start Remote Control only from the server header and keep a hidden session active until the user
  disconnects or changes servers.

### Removed

- Remove QuickDesk, VNC, noVNC, remote passwords, and view-only remote access paths.

### Security

- Authorize Remote Control through active team membership and one-time in-memory viewer grants.
- Verify the local Sunshine TLS chain and pin the exact generated certificate.

## [0.1.11] - 2026-08-16

### Added

- Render Markdown and plain web links with site favicons, safe fallbacks, and system-browser opening.

### Fixed

- Automatically unarchive stored Codex sessions before resuming work or reading conversation history.
- Use trusted Chromium input events and one consistent page and network identity in the embedded browser so X sign-in and account confirmation work.
- Send signed-out X landing pages to the stable login route while preserving signed-in sessions.

## [0.1.10] - 2026-08-14

### Fixed

- Detect Codex and Claude in current Windows installer locations and in npm paths that contain spaces.
- Report a CLI that exists but cannot start instead of incorrectly reporting it as not installed.

## [0.1.9] - 2026-08-14

### Fixed

- Allow Codex or Claude selection on the initial setup screen while provider checks run or setup is still required.

## [0.1.8] - 2026-08-14

### Added

- Add GitHub-hosted Windows x64 CI builds and unsigned NSIS release installers.
- Add Windows package launch, metadata, updater, and Electron fuse checks.

### Changed

- Publish macOS and Windows assets together only after both release jobs pass.
- Detect local Codex and Claude CLI installations and enable installed updates on Windows.
- Keep native window controls visible on Windows.

## [0.1.7] - 2026-08-14

### Changed

- Make the message composer grow up to six lines and preserve multiline typing and paste input.

### Fixed

- Prevent horizontal scrolling in chats and wrap long URLs and paths inside message bubbles.

## [0.1.6] - 2026-08-14

### Fixed

- Keep the first sent message visible and close onboarding after a successful send.

## [0.1.5] - 2026-08-14

### Changed

- Require an explicit model choice before a new empty agent can accept messages.
- Show the specialty step immediately after model selection and after creating an agent.
- Allow browser and settings panels to expand while keeping a usable conversation area.
- Close an agent settings panel when switching chats and use clearer provider marks in model pickers.

### Fixed

- Show complete Claude responses immediately when stream deltas are missing or incomplete instead of requiring a chat refresh.

## [0.1.4] - 2026-08-13

### Fixed

- Present embedded browser requests as standard Chrome requests so X login and signup flows work.
- Restart expired X onboarding routes from the stable login entry after an app restart.
- Persist embedded browser tabs, active tab selection, URLs, and agent ownership across app restarts.
- Revalidate top-level browser navigation to avoid stale cached pages.

## [0.1.3] - 2026-08-13

### Added

- Agent headers, settings, and onboarding now use one model picker with provider availability, CLI version, and account details.

### Changed

- Changing the preferred provider now updates the active account details and default model immediately.
- Development mode now watches source files for changes.

## [0.1.2] - 2026-08-13

### Changed

- New Claude agents now use Claude Opus 5 as their default model.
- Agent onboarding and runtime settings now use one consistent compact card layout.

### Fixed

- Creating an agent now opens its settings panel immediately.

## [0.1.1] - 2026-08-13

### Added

- Claude CLI support with automatic Codex and Claude availability checks.
- Per-agent provider and model selection during onboarding and in agent settings.
- First-launch provider selection with macOS permission status and later account-menu access.

### Changed

- Simplified provider selection to show clear availability without decorative provider cards.
- Development state reset now deletes `OpenBot Dev` state without creating a backup.

### Fixed

- Shutdown now waits for active queue writes before closing local storage.

## [0.1.0] - 2026-08-13

### Added

- Signed GitHub Releases update pipeline with in-app availability, download progress, and restart-to-install controls.
- Public repository documentation, community health files, CI, and draft release automation.
- Apache-2.0 licensing and an attribution notice for Norbert Bodziony.
- Local Codex App Server lifecycle and ChatGPT subscription authentication.
- Per-agent context-budget monitoring and proactive App Server thread compaction.
- Persistent agents with independent threads, workspaces, profiles, models, and reasoning settings.
- FIFO queues, agent-to-agent messaging, replies, reactions, attachments, and file transfers.
- Embedded browser control and optional macOS Computer Use integration.
- SolidJS desktop interface with resizable agent, browser, and settings panels.
- Explicit first-launch consent before the full-access Codex service can start.
- Local ZIP backups, privacy-safe diagnostics, release SBOMs, and multi-version macOS CI checks.

### Changed

- Standardized the product name and all user-facing branding as `OpenBot`.
- Replaced the remaining third-party-inspired avatar SVG with an original OpenBot placeholder mark.
