# Changelog

All notable changes to OpenBot will be documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Keep the embedded browser panel closed until requested and prevent repeated toggles from opening duplicate tabs.
- Restore embedded X sign-in with persistent cookie consent, a compatible browser identity, and current login routing.
- Flush the embedded browser profile before restarts, system shutdowns, and application updates so authenticated sessions persist.

## [0.4.0] - 2026-08-30

### Added

- Add a macOS Dynamic Island overlay for messages, questions, approvals, browser takeovers, and failures.
- Add persistent question prompt bubbles with safe handling for secret answers.
- Let agents attach local response images with preview, download, and file actions.
- Negotiate compatible Team API protocol versions and capabilities between clients and hosts.

### Changed

- Redesign the account dock, usage popover, account menu, and Marketplace access.
- Improve browser takeover cards with persistent page previews and completed states.
- Hide People communication by default while retaining an explicit opt-in.
- Require macOS 13 or newer after the Electron and Chromium upgrade.

### Fixed

- Support embedded Google sign-in with the current Chromium identity while keeping the OpenBot browser session.
- Clear Bot unread state reliably when a chat opens or refreshes.
- Preserve agent names before title badges truncate in the sidebar.

## [0.3.5] - 2026-08-27

### Changed

- Download and verify the Whisper model on first voice use instead of shipping it in every application update.
- Remove provider runtimes from macOS and Windows application packages while keeping system CLIs as the first choice.
- Install application updates only after the user selects `Restart and install`.

### Added

- Download Codex, Claude, and Grok provider runtimes on demand from pinned vendor artifacts.
- Show provider download, setup, retry, and connection actions in onboarding, Settings, Bot setup, and model selection.

### Fixed

- Wait for native macOS update staging before offering a restart, and require an explicit update restart on Windows.
- Reject oversized or inconsistent release artifacts and remove duplicate native runtime files from packages.
- Stream large provider downloads to disk, support safe resume, and reject unsafe or invalid runtime archives.
- Respect Windows shutdown and sign-out without starting the NSIS updater.

## [0.3.4] - 2026-08-26

### Fixed

- Verify source-built Windows remote desktop binaries as intentionally unsigned while preserving strict vendor signature checks.

## [0.3.3] - 2026-08-26

### Fixed

- Isolate Windows package signature checks from the PowerShell 7 module path used by GitHub Actions.

## [0.3.2] - 2026-08-26

### Fixed

- Stage Claude and Grok runtimes on the destination volume before the atomic Windows install switch.

## [0.3.1] - 2026-08-26

### Fixed

- Resolve bundled provider and fallback CLI paths with the target platform's path format.

## [0.3.0] - 2026-08-26

### Added

- Add the Grok CLI provider and bundle the supported provider CLIs for a more reliable onboarding experience.
- Add attachments directly in the conversation composer and connect the agent marketplace.
- Add per-participant emoji reactions, including optional context-aware bot reactions to user messages.
- Add improved server invitation and member workflows.

### Changed

- Rebuild chat messages on reusable bubble primitives and refresh settings, routines, and related popovers.

### Fixed

- Preserve the active server across refreshes and make server address copying reliable.
- Improve composer mentions, worktree setup, invitation handling, and emoji reaction presentation.

## [0.2.1] - 2026-08-25

### Added

- Add scheduled agent routines with timezone-aware schedules, manual test runs, run history, and delivery in the agent chat.
- Add agent memories, shared sidebar sections, and the skills marketplace.

### Changed

- Refresh the sidebar, agent settings, dialogs, buttons, switches, selects, and Storybook examples with the shared visual system.

### Fixed

- Prevent resumed routines from running missed schedules and protect unsaved routine edits before navigation.
- Render newly appended chat messages without virtualizer refresh loops.

## [0.2.0] - 2026-08-24

### Added

- Add the production Create Bot flow with practical suggestions, synchronized animated avatars, and first/additional Bot modes.

### Changed

- Create a Bot only after its complete profile is submitted, then queue its initial role message as one rollback-safe operation.
- Replace the legacy new-agent picker and empty-chat onboarding with the dedicated Bot setup screen.

### Fixed

- Keep the technical development client out of a normal private dev server while preserving the two-client test harness.
- Limit the first visible Bot message to its ongoing role.

## [0.1.22] - 2026-08-24

### Added

- Add a resizable browser Picture-in-Picture panel that stays visible while the conversation remains usable.

### Changed

- Keep application and conversation state stable during renderer hot updates, including selections, drafts, search, panel state, and active resources.
- Simplify the Remote Control toolbar and show agent animation while a remote desktop connection starts.

## [0.1.21] - 2026-08-23

### Fixed

- Restore the Solid signals runtime dependency required by production builds.

## [0.1.20] - 2026-08-22

### Changed

- Split team IPC registration, renderer message projection, voice status helpers, and workspace path handling into focused modules.
- Remove unused dependencies, renderer exports, preview helpers, and an inactive visual test suite while keeping active Storybook coverage.

### Fixed

- Hide unexpected Team API failures from remote clients while preserving controlled validation errors.
- Bound unauthenticated sign-in rate-limit state and reject oversized WebSocket event frames before application parsing.
- Make team and remote-server state writes atomic, isolated, and able to recover after a failed write.

## [0.1.19] - 2026-08-22

### Changed

- Load the interactive landing preview from server markup and retry its ready handshake until playback starts.
- Cache the verified Whisper model in application CI and release workflows.

### Fixed

- Exit a second desktop app process immediately when another OpenBot instance already holds the profile lock.
- Keep the agent activity avatar visible for 500 ms after streaming ends and preserve its layout space when it exits.
- Show the message queue only while a delivery is starting or running, so the first message does not flash in Queue.

## [0.1.18] - 2026-08-22

### Added

- Add paginated conversation loading, global message search, direct-conversation history, and persisted read state.
- Add Markdown rendering with code blocks, tables, task lists, links, images, and attachment references.
- Add privacy-safe desktop and landing-page analytics with test coverage.
- Add a central Content Security Policy for the Electron renderer.

### Changed

- Rework chat rendering and virtualization for smoother streaming, stable bottom following, and large histories.
- Show one stable animated agent avatar and status label for each active response, including reduced-motion support.
- Improve the development landing preview, conversation stories, and seeded demo content.
- Add a staged hero entrance and a skeleton-to-preview reveal on the public landing page.
- Extend local and remote team chat contracts for message history, search, reactions, files, and read state.

### Fixed

- Keep queued messages in their panel until work starts and display each user message before its matching response.
- Animate queue entry removal and panel resizing without abrupt chat movement.
- Keep the activity avatar visible until response streaming ends, then close it with a soft transition.
- Smooth message height changes and preserve bottom scroll while streamed content grows.

## [0.1.17] - 2026-08-22

### Fixed

- Authenticate pinned runtime release lookups in GitHub Actions to avoid unauthenticated API rate-limit failures.

## [0.1.16] - 2026-08-22

### Changed

- Open an agent chat directly from incoming and outgoing exchange markers instead of showing a separate exchange history dialog.
- Use Luna with low reasoning effort for every deterministic development seed agent.

### Fixed

- Run development-state reset tests in the Node environment so CI and signed release builds can load `node:sqlite`.
- Keep message links, inline citations, and source references routed to the system browser, with a clear error when opening fails.

## [0.1.15] - 2026-08-22

### Added

- Add conversational bot profile updates for `name`, `title`, and `description`, plus profile-based agent discovery and message routing.
- Add a guided first-run onboarding flow and deterministic development seed data for integrated UI testing.
- Add managed transfer manifests, shared-file references, ownership metadata, and integrity checks for message and generated attachments.
- Add the shared Kobalte Select component with Storybook coverage and use it for reasoning controls.

### Changed

- Replace bot profile `role` with `title` in storage, local and remote Team APIs, renderer search, and agent instructions. Team permission roles stay unchanged.
- Start the Auth API with the development app and select available local ports when defaults are busy.
- Compact stored conversation and mailbox event history during the schema version 4 upgrade.
- Simplify queued message handling by removing the paused queue state and resume action.

### Fixed

- Validate copied attachment size and SHA-256 data, and remove bot-owned generated files when an agent is deleted.
- Improve agent settings controls, reasoning selection, profile editing, and file reference rendering.

## [0.1.14] - 2026-08-22

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
