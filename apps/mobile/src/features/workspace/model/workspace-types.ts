import type { BotAvatarHue, ConversationSnapshot, CreateBotInput, UpdateBotInput } from "@openbot/contracts/ipc";

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
}

export interface MobileBot {
  id: string;
  serverId: string;
  name: string;
  title: string;
  description: string;
  preview: string;
  updatedLabel: string;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
}

export const MAX_PINNED_BOTS = 6;

export type ToggleBotPinResult = "limit" | "pinned" | "unpinned";

interface AddRemoteServerInput {
  inviteUrl: string;
}

export interface MobileWorkspaceContextValue {
  servers: MobileServer[];
  serverDirectoryState: MobileServerDirectoryState;
  serverDirectoryError: string | null;
  bots: MobileBot[];
  activeServer: MobileServer;
  activeBots: MobileBot[];
  hiddenBots: MobileBot[];
  pinnedBotIds: string[];
  unreadBotIds: string[];
  conversations: Record<string, ConversationSnapshot>;
  selectServer: (serverId: string) => void;
  refreshServers: () => Promise<void>;
  addRemoteServer: (input: AddRemoteServerInput) => Promise<void>;
  createBot: (input: CreateBotInput) => Promise<void>;
  updateBot: (input: UpdateBotInput) => Promise<void>;
  deleteBot: (botId: string) => Promise<void>;
  duplicateBot: (botId: string) => Promise<void>;
  loadConversation: (botId: string) => Promise<ConversationSnapshot>;
  sendMessage: (botId: string, text: string) => Promise<void>;
  hideBot: (botId: string) => void;
  unhideBot: (botId: string) => void;
  markBotRead: (botId: string) => void;
  markBotUnread: (botId: string) => void;
  toggleBotPin: (botId: string) => ToggleBotPinResult;
}
