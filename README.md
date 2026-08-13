# OpenBot

[![CI](https://github.com/NorbertBodziony/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/NorbertBodziony/openbot/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

OpenBot is a local-first desktop workspace for persistent AI teammates. It supports the local
[Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[Claude Code](https://code.claude.com/docs/en/overview). It gives every agent its own workspace and
conversation, and provides local queues, file transfers, an embedded browser, and agent-to-agent
messaging in one macOS app.

> [!WARNING]
> OpenBot is a development preview. Agents currently run with `danger-full-access` and
> `approvalPolicy: never`. They can read and modify files, run commands, use the network, and control
> the embedded browser without per-action confirmations after the explicit first-launch consent.
> Run only agents and tasks you trust, keep backups, and review [Security](#security) before use.

## What works

- Persistent agents backed by independent Codex or Claude threads and local workspaces.
- Per-agent context monitoring with automatic compaction before long threads exhaust the model window.
- FIFO message queues with pause, resume, cancellation, and crash-safe persistence.
- Agent-to-agent messages, replies, reactions, images, and managed file transfers.
- A persistent embedded browser that agents can open, inspect, and control.
- Optional Computer Use integration for macOS through a locally installed Codex plugin.
- Per-agent model, reasoning, profile, notification, browser, and panel state.
- Local data and privacy-safe diagnostics exports from the account menu.
- No OpenBot cloud backend, account system, telemetry service, or copied CLI credentials.

OpenBot is local-first, not offline-only. Codex connects to OpenAI, Claude connects to Anthropic,
visited pages use the network, and installed plugins may connect to their own services.

## Install

OpenBot currently supports macOS 12 or newer on Apple Silicon.

1. Download the latest `OpenBot-*.dmg` from [GitHub Releases](https://github.com/NorbertBodziony/openbot/releases).
2. Drag OpenBot to Applications and open it.
3. Install at least one supported CLI. You can install both.

   Codex CLI:

   ```bash
   curl -fsSL https://chatgpt.com/codex/install.sh | sh
   ```

   Claude CLI:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

4. Run `codex login` or `claude auth login` in Terminal.
5. Restart OpenBot. Each available provider appears in the agent model list.

Bun and Node.js are not required when using an installed release. Screen Recording and Accessibility
permissions are needed only for the optional Computer Use plugin.

OpenBot uses the existing local CLI login. It does not copy tokens from `~/.codex` or `~/.claude`.
See the official Codex and Claude authentication documentation for account setup.

For setup problems, data reset, and uninstall instructions, see
[Troubleshooting](docs/TROUBLESHOOTING.md). OpenBot's data and network behavior is documented in
[Privacy](PRIVACY.md).

## Development

Development requires [Bun](https://bun.sh/) 1.3.11, Node.js 22.12 or newer, and at least one
supported agent CLI.

```bash
git clone https://github.com/NorbertBodziony/openbot.git
cd openbot
bun install --frozen-lockfile
bun run codex:doctor
bun run dev
```

`codex:doctor` checks the CLI version, App Server handshake, ChatGPT login, and Computer Use plugin
without starting a model turn.

To reset only the local development state, quit the dev app and run `bun run dev:reset`. The command
deletes the development state. It does not change agent workspaces or CLI sessions.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start Electron with renderer HMR. |
| `bun run dev:reset` | Delete the local development state. |
| `bun run check` | Run Biome, both typechecks, offline tests, the browser smoke test, and the production build. |
| `bun run test:backend` | Run backend tests only. |
| `bun run test:browser` | Run the local embedded-browser smoke test. |
| `bun run test:codex` | Probe the real CLI handshake and account without starting a paid turn. |
| `bun run package` | Build an unpacked local ARM64 application. |
| `bun run package:verify` | Build and verify the real ARM64 app bundle, icon, metadata, ASAR, and fuses. |
| `bun run release:preflight` | Verify version, Git state, Apple signing, and GitHub release secrets before tagging. |
| `bun run dist:mac` | Build unsigned local ARM64 DMG and ZIP update artifacts. |
| `bun run release:patch` | Create the next patch version commit and tag. |
| `bun run test:filesystem` | **Online/manual:** run a real full-access Codex filesystem turn. |
| `bun run test:imagegen` | **Online/manual:** run a real full-access image-generation turn. |

The normal `check` command is offline and uses a fake App Server. Manual smoke scripts may use the
signed-in subscription and must not run in CI.

## Architecture

```text
Electron main
├── local Codex App Server process over stdio JSONL
├── local Claude Agent SDK session over stream JSON
├── persistent bot and mailbox stores
├── secure typed IPC handlers
└── sandboxed WebContentsView browser host
    ↕ typed preload bridge
SolidJS renderer
```

- `src/main` owns the Electron lifecycle, window security, local protocol, and IPC registration.
- `src/backend` owns provider adapters, persistence, message scheduling, transfers, and the browser host.
- `src/preload` exposes only the typed `window.openbot` API.
- `src/renderer` contains the SolidJS interface.
- `src/shared` contains process-boundary contracts.

## Local data and network boundaries

- `~/OpenBot/Bots/<bot-id>` — one working directory per agent.
- `~/OpenBot/Shared` — files intentionally shared between agents.
- `~/OpenBot/Downloads` — embedded-browser downloads.
- Electron `userData` — bot metadata, queues, drafts, and attachment indexes.
- `~/.codex` — login and thread history managed exclusively by Codex CLI.
- `~/.claude` — login and session history managed exclusively by Claude CLI.

OpenBot does not open an application HTTP port. Electron communicates with local CLI processes over
stdio. The embedded browser uses a separate sandboxed Electron session and cannot access
`window.openbot` or managed local attachments.

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
signed and notarized ARM64 release.
Installed builds check GitHub Releases for updates and expose download/restart controls in the account
popover. Release signing secrets and the complete procedure are documented in
[docs/RELEASING.md](docs/RELEASING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By contributing, you agree that your contribution is licensed
under Apache-2.0. Community behavior is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License and attribution

Copyright 2026 Norbert Bodziony.

Licensed under the [Apache License 2.0](LICENSE). You may use, modify, and distribute the code under
that license, provided its license and attribution notices are preserved. See [NOTICE](NOTICE).

OpenBot is an independent open-source project and is not affiliated with, endorsed by, or
sponsored by OpenAI. OpenAI, ChatGPT, and Codex are used only to describe compatibility with their
respective products and services.
