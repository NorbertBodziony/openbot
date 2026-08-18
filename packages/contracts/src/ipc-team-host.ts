export type ServerConnectionState = "online" | "connecting" | "offline" | "error";
export type TeamRole = "owner" | "admin" | "member";

export interface ServerSummary {
  id: string;
  name: string;
  kind: "local" | "remote";
  state: ServerConnectionState;
  apiUrl: string | null;
  vncHostname: string | null;
  role: TeamRole | null;
  active: boolean;
}

export interface JoinServerInput {
  inviteUrl: string;
}

export interface LoginServerInput {
  serverId: string;
}

export type HostPhase = "unconfigured" | "idle" | "starting" | "online" | "stopping" | "error";

export interface HostStatus {
  phase: HostPhase;
  configured: boolean;
  enabledOnLaunch: boolean;
  serverId: string | null;
  serverName: string | null;
  apiUrl: string | null;
  vncHostname: string | null;
  apiOnline: boolean;
  vncOnline: boolean;
  remoteDesktopCredentialConfigured: boolean;
  message: string | null;
}

export interface ConfigureHostInput {
  serverName: string;
}

export interface ConfigureRemoteDesktopInput {
  password: string;
}

export interface TeamMemberSummary {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  role: TeamRole;
  createdAt: string;
  disabled: boolean;
}

export interface InviteSummary {
  id: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
  inviteUrl: string;
  email: string | null;
}

export interface TeamInviteSummary {
  id: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
  email: string | null;
}

export interface CreateTeamInviteInput {
  role: Exclude<TeamRole, "owner">;
  email?: string;
}

export interface TeamSessionSummary {
  id: string;
  memberId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
}

export interface UpdateTeamMemberInput {
  memberId: string;
  role?: Exclude<TeamRole, "owner">;
  disabled?: boolean;
}

export type RemoteMacPhase =
  | "idle"
  | "starting_tunnel"
  | "checking_vnc"
  | "connected"
  | "disconnecting";

export type RemoteMacErrorCode =
  | "cloudflared_not_found"
  | "local_port_unavailable"
  | "tunnel_timeout"
  | "tunnel_disconnected"
  | "invalid_vnc_handshake"
  | "desktop_bridge_unavailable"
  | "desktop_access_not_configured"
  | "desktop_access_denied";

export interface RemoteMacSession {
  id: string;
  serverId: string | null;
  hostname: string;
  localPort: number | null;
  websocketUrl: string | null;
  phase: RemoteMacPhase;
  errorCode: RemoteMacErrorCode | null;
  message: string | null;
  createdAt: string;
}

export interface RemoteMacConnectInput {
  hostname: string;
  serverId?: string | null;
}

export interface RemoteMacCredentials {
  username: string;
  password: string;
  target: string;
}
