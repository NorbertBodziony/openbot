# Privacy

OpenBot is local-first and has no OpenBot-operated account, cloud backend, telemetry service, or
remote conversation store.

## Data stored on your Mac

- `~/OpenBot/Bots` contains one workspace per agent.
- `~/OpenBot/Shared` contains managed transfers shared between agents.
- `~/OpenBot/Downloads` contains files downloaded by the embedded browser.
- `~/Library/Application Support/OpenBot` contains agent metadata, message queues, attachment drafts,
  the shared browser profile, cookies, and application preferences.
- `~/.codex` is owned by Codex CLI and contains its login and thread data. OpenBot does not copy or
  manage Codex credentials.

Attachments copied into OpenBot remain in managed storage after their original file is moved or
deleted. All agents share the embedded browser profile, including cookies and website sessions.

## Network connections

OpenBot itself does not open a listening HTTP port. Network traffic may still occur when:

- the local Codex App Server connects to OpenAI;
- you or an agent visits a page in the embedded browser;
- a locally installed Codex plugin connects to its service;
- an installed build checks GitHub Releases for updates;
- you open an explicitly labeled external support or setup link.

Account usage shown in OpenBot is requested through the local Codex App Server. OpenBot does not send
that usage to its maintainer.

## Agent access

Agents currently use `danger-full-access` with `approvalPolicy: never`. They can read and modify local
files, run programs, use the network, and control the embedded browser without an OpenBot confirmation
dialog. This is an explicit product behavior, not a host security boundary. Keep backups and do not
give an agent a task you would not allow a local command-line tool to perform.

On first launch, OpenBot explains this access and does not start the Codex agent service until you
explicitly accept it. The acceptance record stays in OpenBot's local application-support directory.

Computer Use is provided by a separately installed local Codex plugin. macOS permission prompts and
any plugin safety hand-offs remain controlled by macOS and that plugin.

## Exports

The account menu can export a local ZIP containing agent profiles, conversation snapshots, queues,
and managed message attachments. It intentionally excludes Codex credentials, browser cookies, and
agent workspace files.

The diagnostics export contains application and CLI versions, capability states, and aggregate queue
counts. It contains no conversations, visited URLs, account email, file contents, or local file paths.

## Delete your data

Quit OpenBot, then remove the OpenBot folders listed above. Removing
`~/Library/Application Support/OpenBot` also removes the embedded browser's cookies and logins.
Removing `~/OpenBot` removes agent workspaces, transfers, and downloads. OpenBot does not delete
`~/.codex`; use Codex's own controls if you also want to remove its local data.

Review folders before deleting them and keep a backup of anything you need. Deleted OpenBot data is
not recoverable through an OpenBot cloud service because no such service exists.

## Questions

Use [GitHub Discussions](https://github.com/NorbertBodziony/openbot/discussions) for privacy questions.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), without attaching
credentials, conversations, or unrelated private files.
