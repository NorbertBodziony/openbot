# Privacy

OpenBot is local-first, but it is not offline-only. Agent workspaces, conversations, attachments,
browser data, and team data stay on the computer that runs OpenBot. The optional OpenBot account
service stores the minimum central data needed for email sign-in, account avatars, team invitations,
and published team addresses.

Production builds of OpenBot and the website use a self-hosted OpenPanel service for product
analytics. Development builds, previews, tests, and Storybook do not send analytics.

## Product analytics

The production website records page visits, download clicks, and clicks on allowlisted public links.
The production desktop app records application, sign-in, onboarding, agent, message, turn, prompt,
approval, queue, team, browser, search, Remote Desktop, and update lifecycle events. Event properties
are limited to metadata such as counts, result states, timing, provider, model, reasoning effort,
application version, operating system, and coarse failure codes.

Analytics events do not contain message or direct-message text, prompts, replies, generated content,
search queries, browser URLs or page titles, file names, local paths, commands, raw error messages, or
local identifiers for agents, threads, turns, messages, servers, and team members. Session replay and
automatic interaction capture are disabled.

When a user signs in, OpenPanel receives the OpenBot account ID and email address so events can be
associated with that account. OpenPanel can also derive session, device, browser, operating-system,
network, and approximate geographic metadata from a request. The analytics service runs on OpenBot's
self-hosted infrastructure and receives events through `analytics.openbot.run`. Analytics is always
enabled in production and has no in-product opt-out control.

OpenPanel event and profile data has no automatic retention limit. It remains stored until it is
removed manually or the analytics project is deleted. OpenPanel analytics does not change where
agent workspaces, conversations, attachments, browser data, and team data are stored.

## Data stored by the central account service

The account service runs on Cloudflare Workers. It uses Cloudflare D1 for structured records and
Cloudflare R2 for account avatar files.

The service stores:

- an account ID, normalized email address, identity key, optional name, optional avatar URL, and
  creation and update times;
- email sign-in challenges with the email address, hashes of the challenge ID, one-time code, and
  source IP address, attempt counts, and lifecycle times;
- account sessions with a session ID, account ID, token hash, creation time, last-use time,
  expiration time, and optional revocation time;
- rate-limit keys as hashes, their fixed window start time, and the attempt count;
- short-lived team authentication tickets with a ticket hash, account ID, team server ID, lifecycle
  times, and optional consumption time;
- published team tunnel records with the account ID, team server ID, Cloudflare tunnel ID and name,
  public API and Remote Mac hostnames, status, and lifecycle times;
- the current account avatar file and its content type when the user uploads an avatar.

The service does not store plaintext one-time codes, account session tokens, or team authentication
tickets in D1. It returns a new plaintext secret only to the client that requested it. The desktop
app encrypts its account session token with the operating-system storage protection before it writes
the token to disk.

Account avatar URLs are public, long-lived resources. A person who has the complete URL can request
the avatar without an account session.

## Central data retention

Cloudflare runs a maintenance task once each day. The task removes:

- sign-in challenges after they expire or are consumed;
- account sessions after they expire or are revoked;
- team authentication tickets after they expire or are consumed;
- rate-limit records after their 15-minute window ends.

These technical records are normally removed within 24 hours after they become inactive. A failed
maintenance run can keep them until a later successful run. The task logs only aggregate deletion
counts. It does not log account IDs, email addresses, IP addresses, tokens, or ticket values.

Replacing or deleting an account avatar removes the previous R2 object on a best-effort basis.
Making a team server private removes its central tunnel record and requests removal of its managed
Cloudflare tunnel and DNS records.

## Email delivery and infrastructure providers

OpenBot sends sign-in and team invitation messages through the configured SMTP provider. The
provider receives the recipient address and the message content. A sign-in message contains the
one-time code and its expiration time. A team invitation can contain the inviter address, team name,
role, and invite URL.

Cloudflare processes account API requests and published Team API traffic. Cloudflare and the email
provider can keep their own security, delivery, and network logs under their own policies. These
provider logs are outside the OpenBot application database and its daily maintenance task.

## Data stored on the OpenBot computer

- `~/OpenBot/Bots` contains one workspace per agent.
- `~/OpenBot/Shared` contains managed transfers shared between agents.
- `~/OpenBot/Downloads` contains files downloaded by the embedded browser.
- `~/Library/Application Support/OpenBot` contains the OpenBot SQLite database, agent metadata,
  conversations, message queues, direct messages, reactions, read state, attachment drafts and
  indexes, team configuration, local team members and sessions, the shared browser profile, cookies,
  and application preferences.
- The local team configuration contains team member profiles, password hashes and salts when local
  password sign-in is used, invite and session token hashes, and the team identity key pair.
- `~/.codex` is owned by Codex CLI and contains its login and thread data. OpenBot does not copy or
  manage Codex credentials.
- `~/.claude` is owned by Claude CLI and contains its login and session data. OpenBot does not copy
  or manage Claude credentials.

Attachments copied into OpenBot remain in managed storage after their original file is moved or
deleted. All agents share the embedded browser profile, including cookies and website sessions.

## Published Team API

When the owner publishes OpenBot, the app starts an authenticated Team API on a localhost port and
connects it to a managed Cloudflare Tunnel. Invited team members can use this API according to their
role. The API can provide access to agents, conversations, queues, direct messages, attachments,
browser tabs, usage information, prompts, approvals, and optional Remote Desktop access.

These resources remain on the OpenBot host. The central account service does not copy them into D1
or R2. Their network traffic passes through Cloudflare while the team server is public.

## Other network connections

Network traffic can also occur when:

- the local Codex App Server connects to OpenAI;
- the local Claude Agent SDK connects to Anthropic through Claude CLI;
- a user or an agent visits a page in the embedded browser;
- a locally installed Codex plugin connects to its service;
- an installed build checks GitHub Releases for updates;
- a user opens an explicitly labeled external support or setup link.

Account usage shown in OpenBot is requested through the local Codex App Server. OpenBot does not send
that usage to its maintainer.

## Agent access

Agents currently use `danger-full-access` with `approvalPolicy: never`. They can read and modify local
files, run programs, use the network, and control the embedded browser without an OpenBot confirmation
dialog. This is an explicit product behavior, not a host security boundary. Keep backups and do not
give an agent a task you would not allow a local command-line tool to perform.

On first launch, OpenBot explains this access and does not start the agent services until you
explicitly accept it. The acceptance record stays in OpenBot's local application-support directory.

Computer Use is provided by a separately installed local Codex plugin. macOS permission prompts and
any plugin safety hand-offs remain controlled by macOS and that plugin.

## Exports

The account menu can export a local ZIP containing agent profiles, conversation snapshots, queues,
and managed message attachments. It intentionally excludes CLI credentials, browser cookies, and
agent workspace files.

The diagnostics export contains application and CLI versions, capability states, and aggregate queue
counts. It contains no conversations, visited URLs, account email, file contents, or local file paths.

## Delete local data

Quit OpenBot, then remove the OpenBot folders listed above. Removing
`~/Library/Application Support/OpenBot` also removes the embedded browser's cookies and logins.
Removing `~/OpenBot` removes agent workspaces, transfers, and downloads. OpenBot does not delete
`~/.codex` or `~/.claude`; use each CLI's own controls if you also want to remove its local data.

Review folders before deleting them and keep a backup of anything you need.

## Questions

Use [GitHub Discussions](https://github.com/NorbertBodziony/openbot/discussions) for privacy questions.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), without attaching
credentials, conversations, or unrelated private files.
