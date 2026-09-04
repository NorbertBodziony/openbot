# OpenBot

[![CI](https://github.com/NorbertBodziony/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/NorbertBodziony/openbot/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-PolyForm_Noncommercial_1.0.0-blue.svg)](LICENSE)

OpenBot is a local-first desktop workspace for persistent AI teammates. It supports the local
[Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[Claude Code](https://code.claude.com/docs/en/overview), plus [Grok CLI](https://docs.x.ai/build/overview)
through ACP. It gives every agent its own workspace and
conversation, and provides local queues, file transfers, an embedded browser, and agent-to-agent
messaging in one desktop app.

> [!WARNING]
> OpenBot is a development preview. Agents currently run with `danger-full-access` and
> `approvalPolicy: never`. They can read and modify files, run commands, use the network, and control
> the embedded browser without per-action confirmations after the explicit first-launch consent.
> Run only agents and tasks you trust, keep backups, and review [Security](#security) before use.

## What works

- Persistent agents backed by independent Codex, Claude, or Grok sessions and local workspaces.
- Per-agent context monitoring with automatic compaction before long threads exhaust the model window.
- FIFO message queues with pause, resume, cancellation, and crash-safe persistence.
- Agent-to-agent messages, replies, reactions, images, and managed file transfers.
- A persistent embedded browser that agents can open, inspect, and control.
- Optional Computer Use integration for macOS through a locally installed Codex plugin.
- Per-agent model, reasoning, profile, notification, browser, and panel state.
- Local data and privacy-safe diagnostics exports from the account menu.
- Optional OpenBot accounts through one-time email codes. The account API runs on Cloudflare Workers and D1.

OpenBot is local-first, not offline-only. Codex connects to OpenAI, Claude connects to Anthropic,
Grok connects to xAI,
visited pages use the network, and installed plugins may connect to their own services.

## Install

OpenBot supports macOS 13 or newer on Apple Silicon and Windows 10 or newer on x64 systems.

### macOS

1. Download the latest `OpenBot-*.dmg` from [GitHub Releases](https://github.com/NorbertBodziony/openbot/releases).
2. Drag OpenBot to Applications and open it.

### Windows

1. Download the latest `OpenBot-*-x64.exe` from [GitHub Releases](https://github.com/NorbertBodziony/openbot/releases).
2. Run the installer and open OpenBot.

> [!IMPORTANT]
> The Windows preview is not code-signed. Windows can show an `Unknown publisher` or SmartScreen
> warning. Check the release checksum or GitHub build attestation before you run the installer.

### Agent setup

OpenBot can download a supported provider runtime when you select `Download` in onboarding,
Settings, Bot setup, or the model picker. A compatible system CLI remains the first choice.

You can also install a CLI yourself.

Codex CLI on macOS:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Claude CLI on macOS:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Install Grok CLI following the [Grok Build documentation](https://docs.x.ai/build/overview), then
authenticate with `grok login` or set `XAI_API_KEY` in the environment used to launch OpenBot.

On Windows, install the native CLI and make sure `codex`, `claude`, or `grok` is available in PowerShell.
Claude Code also requires Git for Windows. Then authenticate the installed CLI and restart OpenBot.

Bun and Node.js are not required when using an installed release. Screen Recording and Accessibility
permissions are needed only for the optional Computer Use plugin.

OpenBot uses the existing local CLI login. It does not copy provider credentials. Grok's
`XAI_API_KEY` and per-session MCP bearer tokens are never persisted or logged.

For setup problems, data reset, and uninstall instructions, see
[Troubleshooting](docs/TROUBLESHOOTING.md). OpenBot's data and network behavior is documented in
[Privacy](PRIVACY.md).

## Development

Development requires stable [Bun](https://bun.sh/) 1.4.0, Node.js 24 (the version in `.nvmrc`, matching
the Node that Electron bundles - run `nvm use`), and at least one supported agent CLI.

Install the exact Bun version on macOS or Linux:

```bash
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.0"
```

Install it on Windows in PowerShell:

```powershell
iex "& {$(irm https://bun.com/install.ps1)} -Version 1.4.0"
```

```bash
git clone https://github.com/NorbertBodziony/openbot.git
cd openbot
bun install --frozen-lockfile
bun run codex:doctor
bun run dev
```

`codex:doctor` checks the CLI version, App Server handshake, ChatGPT login, and Computer Use plugin
without starting a model turn.

To reset only the local development state, quit the dev app and test client, then run
`bun run dev:reset`.
The command deletes the app and test-client development profiles plus the legacy host profile,
including `openbot.db` and its WAL files. It does not change the production profile, agent
workspaces, `~/.codex`, or `~/.claude`.

To replace only the app development profile with a durable UI showcase, quit the dev app, then run:

```bash
bun run dev:seed
bun run dev
```

The seed adds agents, rich conversations, managed files and references, reactions, completed
agent exchanges, and local team chat data. It does not add live queue items or start model turns.
Use `bun run dev:seed --dry-run` to inspect the target and fixture counts without changing files.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the local Auth API, Signal service, and Electron client with renderer HMR on its app profile. |
| `bun run preview` | Preview the built Electron client with the green preview icon. |
| `bun run dev:api` | Start the TanStack Start API and its local D1 database on `127.0.0.1:3100`. |
| `bun run api:start` | Build and preview the Cloudflare Worker locally. |
| `bun run api:migrate:local` | Apply D1 migrations to the local development database. |
| `bun run api:migrate:remote` | Apply D1 migrations to the configured remote database. |
| `bun run api:deploy` | Build and deploy the account API to Cloudflare Workers. |
| `bun run remote:up` | Build and start the self-hosted Signal, coturn, and ACME stack. |
| `bun run remote:check` | Check the Remote API and both Docker Compose configurations. |
| `bun run remote:update` | Update Signal, then drain and update the single coturn instance. |
| `bun run dev:all` | Start the Auth API, Signal service, and single local Electron instance. |
| `bun run dev:test-client` | Start the Auth API, Signal service, local instance, and an isolated second client for team testing. |
| `bun run dev:seed` | Replace only the app development profile with deterministic showcase data. |
| `bun run dev:reset` | Delete the local app, test-client, and legacy host development state. |
| `bun run dev:automation` | Drive the running dev app over CDP: `instances`, `pages`, `snapshot`, `screenshot`, `click`/`type` by accessible role. `--page=<index\|url-substring>` aims at any window, including embedded browser views; `--wait-for=<role>,<name>` settles on an accessible target instead of polling; mutations need `--allow-mutations` and a named instance (this worktree's record, `--instance=<id>` or `--port=`). |
| `bun run check` | Run Biome, both typechecks, offline tests, the browser smoke test, and the production build. |
| `bun run test:backend` | Run backend tests only. |
| `bun run test:browser` | Run the local embedded-browser smoke test. |
| `bun run test:codex` | Probe the real CLI handshake and account without starting a paid turn. |
| `bun run package` | Build an unpacked local ARM64 application. |
| `bun run package:verify` | Build and verify the real ARM64 app bundle, icon, metadata, ASAR, and fuses. |
| `bun run package:win` | Build an unpacked local Windows x64 application on Windows. |
| `bun run package:win:verify` | Build and verify the Windows x64 application on Windows. |
| `bun run release:preflight` | Verify version, Git state, and GitHub release secrets before tagging. |
| `bun run dist:mac` | Build unsigned local ARM64 DMG and ZIP update artifacts. |
| `bun run dist:win` | Build an unsigned Windows x64 NSIS installer on Windows. |
| `bun run release:patch` | Create the next patch version commit and tag. |
| `bun run test:filesystem` | **Online/manual:** run real full-access Codex and Claude filesystem turns across private and shared workspaces. |
| `bun run test:imagegen` | **Online/manual:** run a real full-access image-generation turn. |
| `bun run test:storage-live` | **Online/manual:** verify isolated Codex and Claude turns in a temporary SQLite database. |

Publishing never creates a second OpenBot instance. The host keeps its Team API on loopback. A hidden,
sandboxed Electron page connects it to invited clients through WebRTC. Signal carries only connection
setup messages. Team data uses direct DataChannels when possible and the project coturn service when
direct ICE fails. Cloudflare stores accounts, configuration, memberships, invitations, logical session
records, and public assets. It does not carry chats, files, commands, or remote desktop media.

The development runner advertises both Mobile Connect and its Signal service on the preferred private
LAN interface. Restart the runner after changing networks so newly generated QR codes contain the
current address.

For manual team testing, `bun run dev:test-client` starts a complete two-client harness. The second
client uses the isolated `OpenBot Dev Test Client` profile and renderer port 5174. `dev:reset` also
removes that profile and the legacy `OpenBot Dev Host` profile. Press `Ctrl+C` in the runner terminal
to stop only the processes started by that runner.

Set `OPENBOT_DEV_ICE_TRANSPORT_POLICY=relay` before this command to force Team API traffic through
coturn. This test option works only with the development renderer. Production always starts with `all`.

The normal `check` command is offline and uses a fake App Server. Manual smoke scripts may use the
signed-in subscription and must not run in CI.

Local agents run with the providers' unrestricted execution modes. Each agent starts in its own
persistent `~/OpenBot/Bots/<agent>` workspace and also receives `~/OpenBot/Shared`; routine command
and filesystem work in both locations runs without OpenBot adding another permission boundary.
Because these modes are intentionally unrestricted, they also permit host access outside those
directories when the provider and operating system allow it.

## Architecture

```text
Electron main
├── local Codex App Server process over stdio JSONL
├── local Claude Agent SDK session over stream JSON
├── SQLite command log and read projections
├── secure typed IPC handlers
└── sandboxed WebContentsView browser host
    ↕ typed preload bridge
SolidJS renderer

Cloudflare Workers
└── TanStack Start + Solid 2 account API
    ├── D1 accounts, email challenges, hashed sessions, and team tunnels
    └── R2 account avatars
```

- `src/main` owns the Electron lifecycle, window security, local protocol, and IPC registration.
- `src/backend` owns provider adapters, persistence, message scheduling, transfers, and the browser host.
- `src/preload` exposes only the typed `window.openbot` API.
- `src/renderer` contains the SolidJS interface.
- `apps/auth-api` contains the TanStack Start account API, one-time email codes, rate limits, and D1 migrations.
- `packages/contracts` contains process-boundary contracts, shared limits, and pure validation.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for dependency direction, state ownership, and
rules for new modules.

## Local data and network boundaries

- `~/OpenBot/Bots/<bot-id>` — one working directory per agent.
- `~/OpenBot/Shared` — files intentionally shared between agents.
- `~/OpenBot/Shared/Transfers` — managed message snapshots and generated files. Each transfer has
  an `.openbot-transfer.json` manifest with ownership, recipients, size, and SHA-256 metadata.
- `~/OpenBot/Downloads` — embedded-browser downloads.
- Electron `userData/openbot.db` — the canonical OpenBot event log and projections for agents,
  conversations, provider session bindings, queues, reactions, and attachment indexes.
- Electron `userData/legacy-backup-v1` — unchanged copies of imported `bots.json` and
  `mailbox.json` files, when these files existed before the SQLite migration.
- `~/.codex` — login and thread history managed exclusively by Codex CLI.
- `~/.claude` — login and session history managed exclusively by Claude CLI.
- `~/.grok` — login and session history managed exclusively by Grok CLI.

Deleting an agent removes its workspace, owned generated attachments, and deliveries addressed only
to that agent. A transfer remains when another agent still uses the same message.

OpenBot keeps one stable local conversation when an agent changes between Codex, Grok, and Claude. Native
provider session identifiers stay private and are used only to resume provider runtime state.

The Electron renderer is never exposed as a public website. It communicates with local CLI processes
over stdio. When the owner publishes OpenBot, its authenticated Team API stays on localhost. WebRTC
protocol v3 carries RPC, events, and binary files to desktop and mobile clients. Expo Go hosts the
mobile `RTCPeerConnection` in a hidden Expo DOM component, so mobile uses the same encrypted transport
without a custom native development build. The account flow connects to
the configured HTTPS Cloudflare API. The client stores only an encrypted OpenBot session token. One-time codes expire after
10 minutes and are stored only as hashes. A daily maintenance task removes expired or consumed
authentication records from D1. The embedded browser uses a separate sandboxed Electron session and
cannot access `window.openbot` or managed local attachments.

## Security

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not put credentials, private
files, conversation contents, or sensitive diagnostics in a public issue.

Full local access is an explicit current product decision, not a security boundary. Reports are
especially useful when remote content can reach Electron privileges, managed attachment paths can
escape their roots, IPC sender validation can be bypassed, or an agent can act outside the access
described above.

## Releases

Releases are tag-driven. `bun run release:patch`, `release:minor`, or `release:major` prepares the
version and changelog. After review, commit, preflight, and tag the release; pushing the tag builds a
signed and notarized macOS ARM64 release and an unsigned Windows x64 release in GitHub Actions.
Installed builds check GitHub Releases for updates and expose download/restart controls in the account
popover. Release signing secrets and the complete procedure are documented in
[docs/RELEASING.md](docs/RELEASING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By contributing, you agree that your contribution is licensed
under PolyForm Noncommercial 1.0.0. Community behavior is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License and attribution

Copyright 2026 Norbert Bodziony.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify, and
distribute the code for permitted noncommercial purposes. Commercial use requires a separate license
from the copyright owner. Versions up to and including 0.1.11 remain available under Apache-2.0.
See [NOTICE](NOTICE) for attribution and third-party notices.

OpenBot is an independent source-available project and is not affiliated with, endorsed by, or
sponsored by OpenAI. OpenAI, ChatGPT, and Codex are used only to describe compatibility with their
respective products and services.
