export type MobileServerKind = "local" | "remote";
export type MobileServerState = "online" | "offline";

export interface MobileServer {
  id: string;
  name: string;
  kind: MobileServerKind;
  state: MobileServerState;
  address: string | null;
  accent: string;
}

export interface MobileBot {
  id: string;
  serverId: string;
  name: string;
  title: string;
  preview: string;
  updatedLabel: string;
  avatarSeed: string;
}

export const MAX_PINNED_BOTS = 6;

export type ToggleBotPinResult = "limit" | "pinned" | "unpinned";

interface AddRemoteServerInput {
  inviteUrl: string;
}

export interface MobileWorkspaceContextValue {
  servers: MobileServer[];
  bots: MobileBot[];
  activeServer: MobileServer;
  activeBots: MobileBot[];
  hiddenBots: MobileBot[];
  pinnedBotIds: string[];
  unreadBotIds: string[];
  selectServer: (serverId: string) => void;
  addRemoteServer: (input: AddRemoteServerInput) => void;
  deleteBot: (botId: string) => void;
  duplicateBot: (botId: string) => void;
  hideBot: (botId: string) => void;
  unhideBot: (botId: string) => void;
  markBotRead: (botId: string) => void;
  markBotUnread: (botId: string) => void;
  toggleBotPin: (botId: string) => ToggleBotPinResult;
}
