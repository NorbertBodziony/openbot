// Every Team API path the desktop builds, in one place.
//
// The host router in `src/main/team-api-server.ts` and the client in `src/main/remote-server-manager.ts`
// are two hand-written halves of one HTTP surface, and until this table every path was a bare string
// literal on both of them - plus a third copy in the IPC handlers that call through. Nothing linked
// the copies, so a rename that missed one half broke every remote server silently. The IPC channel
// version of that mistake is caught by `src/main/ipc-channel-coverage.test.ts`; this had no
// equivalent, which is why it comes with a round-trip case in `src/main/team-api-server.test.ts`.
//
// These are path *builders*, not a matcher, and every entry is exactly what the host compares
// `url.pathname` against - queries stay at the call site that knows the parameters. The host does not
// compare full paths for the parametric routes: it regex-matches `/v1/agents/:botId` and switches on
// an action sub-segment, so a shared matcher would mean rewriting its 404 and 405 semantics. Static
// entries are for both halves; the host's regex branches stay literal.
//
// The frozen artifacts under `./team-protocol` deliberately do not import this table. `v1.ts` keeps
// its own copy of the route list because it classifies requests for a *released* wire protocol: if a
// rename here followed into it, the meaning of a shipped protocol would change, and that is the one
// thing a released adapter may never do. The duplication there is the point - do not "fix" it.
//
// The cloud account API in `apps/auth-api` serves `/v1/...` paths of its own. It is an unrelated
// service reached by `central-auth-manager.ts` and the marketplace services, and its routes do not
// belong here.

function segment(value: string): string {
  return encodeURIComponent(value);
}

// The remote-screen namespace, exposed on the group below as `prefix` because it is rewritten as a
// *string inside a served body*, not built as a path: `remote-viewer-proxy.ts` prefixes every
// occurrence in the viewer's HTML and JavaScript with its own server-scoped base, so a rename here
// that the proxy did not follow would leave those assets pointing outside the proxy and 404. The
// group's entries are built from it so there is one source, not a fifth copy.
const REMOTE_SCREEN = "/v1/remote-screen";

export const TEAM_API_ROUTES = {
  compatibility: "/v1/compatibility",
  identity: "/v1/identity",
  events: "/v1/events",
  me: "/v1/me",
  attachments: "/v1/attachments",
  attachment: (attachmentId: string) => `/v1/attachments/${segment(attachmentId)}`,
  sharedFiles: "/v1/shared-files",
  workspaceFiles: "/v1/workspace-files",
  // The WebSocket upgrade path, not a JSON endpoint.
  remoteDesktopUpgrade: "/v1/remote-desktop",
  join: {
    server: "/v1/join",
    account: "/v1/join/account",
    invitationPreview: "/v1/invitations/preview",
  },
  auth: {
    login: "/v1/auth/login",
    account: "/v1/auth/account",
    logout: "/v1/auth/logout",
    password: "/v1/auth/password",
  },
  host: {
    remoteMac: "/v1/host/remote-mac",
    remoteDesktopAccess: "/v1/host/remote-desktop-access",
  },
  team: {
    presence: "/v1/team/presence",
    logo: "/v1/team/logo",
    members: "/v1/team/members",
    member: (memberId: string) => `/v1/team/members/${segment(memberId)}`,
    invites: "/v1/team/invites",
    invite: (inviteId: string) => `/v1/team/invites/${segment(inviteId)}`,
    sessions: "/v1/team/sessions",
    session: (sessionId: string) => `/v1/team/sessions/${segment(sessionId)}`,
  },
  direct: {
    threads: "/v1/direct/threads",
    messages: "/v1/direct/messages",
    conversation: (memberId: string) => `/v1/direct/conversations/${segment(memberId)}`,
    conversationPage: (memberId: string) => `/v1/direct/conversations/${segment(memberId)}/page`,
    conversationRead: (memberId: string) => `/v1/direct/conversations/${segment(memberId)}/read`,
  },
  messages: {
    search: "/v1/messages/search",
  },
  browser: {
    open: "/v1/browser/open",
    activate: "/v1/browser/activate",
    navigate: "/v1/browser/navigate",
    reload: "/v1/browser/reload",
    close: "/v1/browser/close",
    tabs: "/v1/browser/tabs",
    control: "/v1/browser/control",
    preview: "/v1/browser/preview",
    visible: "/v1/browser/visible",
  },
  remoteScreen: {
    prefix: REMOTE_SCREEN,
    capabilities: `${REMOTE_SCREEN}/capabilities`,
    sessions: `${REMOTE_SCREEN}/sessions`,
    session: (sessionId: string) => `${REMOTE_SCREEN}/sessions/${segment(sessionId)}`,
    display: `${REMOTE_SCREEN}/display`,
    // Served by `remote-screen-gateway.ts`, which the Team API router delegates the whole
    // `sessions/:id/{viewer,authorize,viewer-state,moonlight}` family to. It is here because the
    // client and the gateway's own `viewerUrl` both build it, and it answers 404 for a session that
    // does not exist - so it is not part of the route round-trip case.
    viewer: (sessionId: string) => `${REMOTE_SCREEN}/sessions/${segment(sessionId)}/viewer`,
  },
  sidebarLayout: {
    state: "/v1/sidebar-layout",
    actions: "/v1/sidebar-layout/actions",
  },
  respond: {
    prompt: "/v1/prompts/respond",
    approval: "/v1/approvals/respond",
    browserTakeover: "/v1/browser-takeovers/respond",
  },
  agents: {
    // GET lists, POST creates.
    all: "/v1/agents",
    status: "/v1/agents/status",
    usage: "/v1/agents/usage",
    models: "/v1/agents/models",
    conversationReads: "/v1/agents/conversation-reads",
  },
  agent: {
    // PATCH updates, DELETE removes.
    one: (botId: string) => `/v1/agents/${segment(botId)}`,
    usage: (botId: string) => `/v1/agents/${segment(botId)}/usage`,
    skills: (botId: string) => `/v1/agents/${segment(botId)}/skills`,
    duplicate: (botId: string) => `/v1/agents/${segment(botId)}/duplicate`,
    avatar: (botId: string) => `/v1/agents/${segment(botId)}/avatar`,
    conversation: (botId: string) => `/v1/agents/${segment(botId)}/conversation`,
    conversationPage: (botId: string) => `/v1/agents/${segment(botId)}/conversation-page`,
    conversationRead: (botId: string) => `/v1/agents/${segment(botId)}/conversation/read`,
    messages: (botId: string) => `/v1/agents/${segment(botId)}/messages`,
    reactions: (botId: string) => `/v1/agents/${segment(botId)}/reactions`,
    interrupt: (botId: string) => `/v1/agents/${segment(botId)}/interrupt`,
    failuresAcknowledge: (botId: string) => `/v1/agents/${segment(botId)}/failures/acknowledge`,
    queue: (botId: string) => `/v1/agents/${segment(botId)}/queue`,
    queueCancel: (botId: string) => `/v1/agents/${segment(botId)}/queue/cancel`,
    queueSteer: (botId: string) => `/v1/agents/${segment(botId)}/queue/steer`,
    queueUpdate: (botId: string) => `/v1/agents/${segment(botId)}/queue/update`,
    queueReorder: (botId: string) => `/v1/agents/${segment(botId)}/queue/reorder`,
    memories: (botId: string) => `/v1/agents/${segment(botId)}/memories`,
    memory: (botId: string, memoryId: string) => `/v1/agents/${segment(botId)}/memories/${segment(memoryId)}`,
    routines: (botId: string) => `/v1/agents/${segment(botId)}/routines`,
    routine: (botId: string, routineId: string) => `/v1/agents/${segment(botId)}/routines/${segment(routineId)}`,
    routineTest: (botId: string, routineId: string) =>
      `/v1/agents/${segment(botId)}/routines/${segment(routineId)}/test`,
    routineRuns: (botId: string, routineId: string) =>
      `/v1/agents/${segment(botId)}/routines/${segment(routineId)}/runs`,
  },
} as const;
