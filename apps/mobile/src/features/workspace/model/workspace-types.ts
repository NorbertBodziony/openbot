import type { AvatarHue, ConversationSnapshot, CreateAgentInput, UpdateAgentInput } from "@openbot/contracts/ipc";

export type MobileServerKind = "local" | "remote";
export type MobileServerState = "connecting" | "online" | "offline";
export type MobileServerDirectoryState = "loading" | "ready" | "error";

export interface MobileServer {
  id: string;
  name: string;
  kind: MobileServerKind;
  state: MobileServerState;
  connectionMessage: string | null;
  address: string | null;
  accent: string;
  publicKey: string;
  membershipId: string;
}

export interface MobileAgent {
  id: string;
  serverId: string;
  name: string;
  title: string;
  description: string;
  preview: string;
  updatedLabel: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
}

export const MAX_PINNED_AGENTS = 6;

export type ToggleAgentPinResult = "limit" | "pinned" | "unpinned" | "error";

interface AddRemoteServerInput {
  inviteUrl: string;
}

export interface MobileWorkspaceContextValue {
  servers: MobileServer[];
  serverDirectoryState: MobileServerDirectoryState;
  serverDirectoryError: string | null;
  agents: MobileAgent[];
  activeServer: MobileServer;
  activeAgents: MobileAgent[];
  hiddenAgents: MobileAgent[];
  pinnedAgentIds: string[];
  unreadAgentIds: string[];
  conversations: Record<string, ConversationSnapshot>;
  selectServer: (serverId: string) => void;
  leaveServer: (serverId: string) => Promise<void>;
  refreshServers: () => Promise<void>;
  addRemoteServer: (input: AddRemoteServerInput) => Promise<void>;
  createAgent: (input: CreateAgentInput) => Promise<void>;
  updateAgent: (input: UpdateAgentInput) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  duplicateAgent: (agentId: string) => Promise<void>;
  loadConversation: (agentId: string) => Promise<ConversationSnapshot>;
  sendMessage: (agentId: string, text: string) => Promise<void>;
  hideAgent: (agentId: string) => void;
  unhideAgent: (agentId: string) => void;
  markAgentRead: (agentId: string, throughMessageId?: string) => void;
  markAgentUnread: (agentId: string) => void;
  toggleAgentPin: (agentId: string) => ToggleAgentPinResult;
}
