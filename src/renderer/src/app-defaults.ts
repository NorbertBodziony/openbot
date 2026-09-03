import type {
  AgentStatus,
  HostStatus,
  ProviderRuntimeSnapshot,
  TeamPresenceSnapshot,
  UpdateStatus,
} from "@openbot/contracts/ipc";

/**
 * What the renderer shows before main has answered, and what it falls back to
 * when a call fails. Every one of these is a projection of "nothing known yet",
 * never durable state.
 */

export const FALLBACK_STATUS: AgentStatus = {
  phase: "starting",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: [
    { id: "codex", state: "not-started", version: null, message: null },
    { id: "claude", state: "not-started", version: null, message: null },
    { id: "grok", state: "not-started", version: null, message: null },
  ],
  capabilities: {
    chat: "unavailable",
    browser: "unavailable",
    computerUse: "unavailable",
  },
  message: "Starting local agent CLIs…",
  fullAccess: true,
};

export const FALLBACK_UPDATE_STATUS: UpdateStatus = {
  phase: "unsupported",
  currentVersion: "",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
  errorCode: null,
};

export const FALLBACK_PROVIDER_RUNTIMES: ProviderRuntimeSnapshot = {
  revision: -1,
  providers: {
    codex: { phase: "not-downloaded", progress: null, message: null, version: null },
    claude: { phase: "not-downloaded", progress: null, message: null, version: null },
    grok: { phase: "not-downloaded", progress: null, message: null, version: null },
  },
};

export const FALLBACK_HOST_STATUS: HostStatus = {
  phase: "unconfigured",
  configured: false,
  enabledOnLaunch: false,
  serverId: null,
  serverName: null,
  logoUrl: null,
  apiUrl: null,
  apiOnline: false,
  remoteDesktopReady: false,
  remoteDesktopUnattended: false,
  remoteDesktopActiveSessions: 0,
  remoteDesktopMaxSessions: 4,
  message: null,
};

export const EMPTY_TEAM_PRESENCE: TeamPresenceSnapshot = {
  serverId: null,
  members: [],
  updatedAt: "",
};
