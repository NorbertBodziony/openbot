import type { AgentProviderId, AvatarImageInput } from "./ipc-conversation";

export type DesktopPlatform = "darwin" | "win32" | "linux";
export type AppVariant = "production" | "dev" | "preview";

export interface AppInfo {
  name: string;
  version: string;
  platform: DesktopPlatform;
  variant: AppVariant;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  checkedAt: string | null;
  message: string | null;
}

export interface ExportResult {
  saved: boolean;
}

export interface AppSetupState {
  completed: boolean;
  preferredProvider: AgentProviderId | null;
}

export interface SaveSetupInput {
  preferredProvider: AgentProviderId;
}

export interface CentralAuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface CentralAuthIssue {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export type CentralAuthState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signing_in" }
  | {
      status: "code_sent";
      challengeId: string;
      email: string;
      expiresAt: number;
      resendAvailableAt: number;
      developmentCode?: string;
      issue?: CentralAuthIssue;
    }
  | { status: "signed_in"; user: CentralAuthUser }
  | { status: "error"; issue: CentralAuthIssue };

export interface CentralAuthDesktopApi {
  getState: () => Promise<CentralAuthState>;
  retry: () => Promise<CentralAuthState>;
  requestEmailCode: (email: string) => Promise<CentralAuthState>;
  verifyEmailCode: (challengeId: string, code: string) => Promise<CentralAuthState>;
  updateAvatar: (image: AvatarImageInput | null) => Promise<CentralAuthState>;
  logout: () => Promise<CentralAuthState>;
  onEvent: (listener: (state: CentralAuthState) => void) => () => void;
}

export type MacPermissionId = "screen-recording" | "accessibility";
export type MacPermissionState = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface MacPermissionsState {
  screenRecording: MacPermissionState;
  accessibility: MacPermissionState;
}

export type ExternalDestination = "agent-setup" | "claude-install" | "claude-sign-in" | "feedback" | "message";
