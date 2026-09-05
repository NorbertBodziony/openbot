# Upgrade surfaces

The path inventory behind the gates in `SKILL.md`. Facts and locations only — the judgement about
what a change to one of these costs stays in `SKILL.md`.

## `userData` files

Every one of these is read and rewritten in place by whichever build opens it last. Nothing copies
any of them before an upgrade. A renamed constant means the old file is never read again; a bumped
`version` with no read path means the old file is read as garbage and replaced with defaults.

| File | Constant | Version handling |
| --- | --- | --- |
| `openbot.db` | `DatabaseCore` in `src/backend/database/database-core.ts` | `schema_migrations`, gate A |
| `openbot-setup-v2.json` | `SETUP_FILE`, `src/main/index.ts` | `src/main/setup-store.ts` accepts only `version === 2`, silent default otherwise |
| `openbot-analytics-preference-v1.json` | `ANALYTICS_PREFERENCE_FILE`, `src/main/index.ts` | `src/main/analytics-preference-store.ts` |
| `openbot-update-preference-v1.json` | `UPDATE_PREFERENCE_FILE`, `src/main/index.ts` | `src/main/update-preference-store.ts` |
| `openbot-dynamic-island-preference-v1.json` | `DYNAMIC_ISLAND_PREFERENCE_FILE`, `src/main/index.ts` | `src/main/dynamic-island-preference-store.ts` reads `version` 1 and 2 forward into 3 |
| `openbot-main-window-state-v1.json` | `MAIN_WINDOW_STATE_FILE`, `src/main/index.ts` | — |
| `openbot-browser-state-v1.json` | `BROWSER_STATE_FILE`, `src/main/index.ts` | `BrowserHost` in `src/backend/browser-host.ts` |
| `openbot-sidebar-layout-v1.json` | `SIDEBAR_LAYOUT_FILE`, `src/main/index.ts` | `src/backend/sidebar-layout-store.ts` |
| `openbot-team-server-v1.json` | `TEAM_FILE`, `src/main/index.ts` | frozen as the last pre-accounts build left it |
| `openbot-team-server-v2.json` | `TEAM_FILE_V2`, `src/main/index.ts` | `src/main/team-store.ts`; both files coexist so a downgrade still finds its host |
| `openbot-remote-servers-v1.json` | `REMOTE_SERVERS_FILE`, `src/main/index.ts` | `src/main/remote-server-stored-shape.ts` reads v1/v2 as v3, preserves unreadable entries, refuses unknown versions |
| `openbot-central-auth-v1.bin` | `CENTRAL_AUTH_FILE`, `src/main/index.ts` | `safeStorage`-encrypted; undecryptable if `appId` or the signing identity changes |
| `openbot-remote-desktop-credential-v1.json` | `LEGACY_REMOTE_DESKTOP_CREDENTIAL_FILE`, `src/main/index.ts` | legacy, still read |
| `openbot-remote-desktop-runtime-v1.json` | `REMOTE_DESKTOP_RUNTIME_SECRET_FILE`, `src/main/index.ts` | `safeStorage`-encrypted; `src/main/remote-desktop-secret-store.ts` accepts only `version: 1` |
| `openbot-dev-remote-connection-v1.json` | `DEVELOPMENT_REMOTE_CONNECTION_FILE`, `src/main/index.ts` | development only |
| `bots.json` | `LEGACY_AGENTS_STATE_FILE`, `src/backend/agent-store.ts` | permanent name; imported once under command id `legacy-import:bots:v1` |
| `mailbox.json` | `src/backend/mailbox-store.ts` | permanent name |
| `sunshine-credentials.json`, `sunshine-state.json`, `sunshine-apps.json`, `moonlight-config.json`, `moonlight-data.json` | `src/main/sunshine-moonlight-runtime.ts` | written by the vendored runtimes, not by OpenBot |
| `avatars/agents/`, `agent-duplications/` | `src/backend/agent-store.ts` | directories under `userData` |
| `legacy-backup-v1/` | `DatabaseCore.backupLegacyFile` | one copy per named legacy file, `COPYFILE_EXCL`; **not** a general backup |

`openbot-data.json` in `src/main/maintenance-service.ts` is the user-initiated export manifest, not
persisted state.

## `~/OpenBot`

Built in the `AgentStore` constructor, `src/backend/agent-store.ts`:

| Directory | Note |
| --- | --- |
| `~/OpenBot/Agents/<agent-id>` | the current workspace root |
| `~/OpenBot/Bots/<bot-id>` | the pre-rename root; permanent, still live after a v13-less restore |
| `~/OpenBot/Shared` | |
| `~/OpenBot/Downloads` | |

`src/backend/workspace-paths.ts` resolves four permanent prefixes — `~/OpenBot/Agents/<id>/`,
`OpenBot/Agents/<id>/`, `~/OpenBot/Bots/<legacy-id>/`, `OpenBot/Bots/<legacy-id>/` — and
`rebaseLegacyWorkspacePath` rebases in both directions, because migration v13's directory move gives
up on `EXDEV` or a permission error while the message paths have already been rewritten.

## Migration constants

All in `src/backend/openbot-database-schema.ts`:

| Constant | Value or meaning |
| --- | --- |
| `BASELINE_SCHEMA_VERSION` | `8` — the frozen baseline, `BASELINE_V8_SCHEMA_SQL` |
| `MIGRATIONS` | versions 8 through 14; a new one is 15 |
| `LATEST_SCHEMA_VERSION` | derived from the last `MIGRATIONS` entry |
| `LATEST_SCHEMA_SQL` | `substituteOnce(BASELINE_V8_SCHEMA_SQL, BASELINE_REACTIONS_TABLE_SQL, V12_REACTIONS_TABLE_SQL)` |
| `substituteOnce` | throws unless the search string appears **exactly once**; handles one table substitution and no more |
| `validateMigrationRegistry` | throws on a non-contiguous version |
| `createLatestDatabase` | execs `LATEST_SCHEMA_SQL`, then stamps every `MIGRATIONS` entry as applied without running it |

Tests: `src/backend/openbot-database-schema-parity.test.ts` (the two build paths must agree),
`src/backend/openbot-database.test.ts` (including "rejects a database created by a newer
application").

## Team API protocol

| Path | Status |
| --- | --- |
| `packages/contracts/src/team-protocol/v1.ts`, `v2.ts`, `v3.ts` | frozen codecs |
| `packages/contracts/src/team-protocol/v1-adapter.ts`, `v2-adapter.ts`, `v3-adapter.ts`, `v3-webrtc-adapter.ts` | registered adapters |
| `packages/contracts/src/team-protocol/fixtures/v1/` | `client-http-request.json`, `client-scope.json`, `host-compatibility.json`, `host-event.json`, `host-http-response.json` |
| `packages/contracts/src/team-protocol/fixtures/v2/` | `client-scope.json`, `event.json`, `file-open.json`, `host-compatibility.json`, `host-event.json`, `host-http-response.json`, `request.json` |
| `packages/contracts/src/team-protocol/fixtures/v3/` | `client-http-request.json`, `host-http-response.json` |
| `packages/contracts/src/team-protocol/current.ts` | where an additive capability goes |
| `packages/contracts/src/team-protocol/current-agent-keys.ts` | the only wire-to-app vocabulary translator |

`current-agent-keys.ts` maps keys (`bot`/`botId`/`bots`/`ownerBotId`/`recipientBotId`/
`recipientBotIds`/`senderBotId`/`typingBotId`), discriminant *values* (`kind: "bot"`, `origin:
"bot"`, `type: "bots-changed"`), and reverses the mapping inside `marketplaceSource`, where
`agentId` names a listing rather than the product agent. Sidebar layout payloads pass through
untouched — they already spell the agent `agent` on both sides.

## IPC channel list and its mirrors

`packages/contracts/src/ipc-channels.ts` declares every channel. Per the table in
`packages/contracts/AGENTS.md`:

| Mirror | What it is |
| --- | --- |
| `src/main/index.ts` and `src/main/ipc/` | the `handleTrusted` registrations, one file per domain |
| `src/preload/index.ts` | the `invoke` calls the renderer reaches |
| `src/renderer/src/preview/mock-openbot.ts` | the second implementation Storybook and the preview run against |

`src/main/ipc-channel-coverage.test.ts` links main and preload statically. The mock is covered by
`tsc` in both directions because it is annotated `: OpenBotDesktopApi`.

## Account Worker

| Path | Note |
| --- | --- |
| `apps/auth-api/migrations/` | `0001` to `0018`; applied **before** the new Worker deploys |
| `apps/auth-api/src/routes/v1/`, `v2/` | the response shapes installed desktop builds keep reading forever |
| `apps/auth-api/src/server/` | the handlers behind those routes |
| `apps/auth-api/test/*-migration.test.ts` | `email-challenge-delivery-migration`, `marketplace-migration`, `mobile-auth-migration` |

`auth:*` channels in `packages/contracts/src/ipc-channels.ts` are the desktop side of this contract.

## Updater and packaging

| Path | Fields that matter |
| --- | --- |
| `electron-builder.yml` | `appId` (`app.openbot.desktop`), `artifactName`, `electronUpdaterCompatibility`, `publish` owner/repo, `mac.extendInfo.ElectronTeamID` (`ZTRDTUL87R`), `extraResources` |
| `src/main/update-service.ts` | the four `UpdateAdapter` behaviours, documented on the type |
| `src/main/electron-updater-assumptions.test.ts` | `VERIFIED_VERSION` |
| `scripts/verify-update-artifacts.ts` | 700 MiB update artifact, 750 MiB DMG, manifest, blockmap, no Whisper model |
| `.github/workflows/release.yml` | macOS ZIP must be under 800,000,000 bytes **and** smaller than the `v0.1.21` ZIP |
