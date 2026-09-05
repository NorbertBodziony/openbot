// What `TeamApiServer` needs from the rest of the main process, and nothing else.
//
// Every service arrives as a `Pick<>` of the real class. The point is not brevity: the Team API is
// reachable from outside the machine, so the narrow type is the written-down list of what a remote
// caller can eventually reach, and widening one to the whole store is how something that was never
// meant to be remote becomes remote. The route modules under this directory each declare their own
// still-narrower `*RouteDependencies` over these.

import type {
  AgentEvent,
  CentralAuthUser,
  CreateTeamInviteInput,
  DirectMessageRealtimeEvent,
  DirectTypingRealtimeEvent,
  InstalledSkill,
  InviteSummary,
  SidebarLayoutSnapshot,
  TeamPresenceSnapshot,
} from "@openbot/contracts/ipc";
import type { Logger } from "@openbot/logging";
import type { AgentService } from "../../backend/agent-service";
import type { BrowserHost } from "../../backend/browser-host";
import type { MailboxStore } from "../../backend/mailbox-store";
import type { SidebarLayoutStore } from "../../backend/sidebar-layout-store";
import type { TeamChatStore } from "../../backend/team-chat-store";
import type { RemoteScreenGateway } from "../remote-screen-gateway";
import type { TeamStore } from "../team-store";

type TeamApiAgentMethods = Pick<
  AgentService,
  | "getStatus"
  | "getRuntimeSnapshot"
  | "getUsage"
  | "listModels"
  | "listBots"
  | "listConversationReads"
  | "createBot"
  | "committedBotDuplication"
  | "duplicateBot"
  | "commitBotDuplication"
  | "updateBot"
  | "deleteBot"
  | "listMemories"
  | "createMemory"
  | "updateMemory"
  | "deleteMemory"
  | "clearMemories"
  | "listRoutines"
  | "createRoutine"
  | "updateRoutine"
  | "deleteRoutine"
  | "testRoutine"
  | "listRoutineRuns"
  | "setAvatar"
  | "resolveAvatar"
  | "readConversationFor"
  | "readConversationPageFor"
  | "searchConversationMessages"
  | "markConversationRead"
  | "markConversationUnread"
  | "prepareImportedAttachments"
  | "discardDraftAttachment"
  | "resolveSharedFile"
  | "resolveWorkspaceFile"
  | "sendMessage"
  | "listQueue"
  | "acknowledgeFailedTurn"
  | "setMessageReaction"
  | "cancelQueuedMessage"
  | "steerQueuedMessage"
  | "updateQueuedMessage"
  | "reorderQueue"
  | "interrupt"
  | "respondToPrompt"
  | "respondToApproval"
  | "respondToBrowserTakeover"
>;

export type TeamApiAgents = TeamApiAgentMethods & {
  on: (event: "event", listener: (event: AgentEvent) => void) => void;
  off: (event: "event", listener: (event: AgentEvent) => void) => void;
};

export type TeamApiMailbox = Pick<MailboxStore, "resolveAttachment">;
export type TeamApiSidebarLayout = Pick<
  SidebarLayoutStore,
  "getSnapshot" | "mutate" | "removeAgent" | "placeDuplicateAfter"
> & {
  on: (event: "changed", listener: (layout: SidebarLayoutSnapshot) => void) => void;
  off: (event: "changed", listener: (layout: SidebarLayoutSnapshot) => void) => void;
};
export type TeamApiBrowser = Pick<
  BrowserHost,
  | "listTabs"
  | "getControlState"
  | "open"
  | "activate"
  | "navigate"
  | "reload"
  | "close"
  | "capturePreview"
  | "setVisible"
>;
export type TeamApiRemoteScreen = Pick<
  RemoteScreenGateway,
  | "handlesUpgrade"
  | "handleUpgrade"
  | "handlesHttp"
  | "handleHttp"
  | "stop"
  | "capabilities"
  | "createSession"
  | "selectDisplay"
  | "closeMemberSession"
  | "revokeTeamSession"
  | "revokeMember"
>;

export interface TeamApiOptions {
  appVersion?: string;
  store: TeamStore;
  agents: TeamApiAgents;
  skills?: { listInstalledForChatTags: (botId: string) => Promise<InstalledSkill[]> };
  sidebarLayout?: TeamApiSidebarLayout;
  mailbox: TeamApiMailbox;
  browser: TeamApiBrowser;
  remoteScreen?: TeamApiRemoteScreen;
  redeemCentralTicket?: (ticket: string, serverId: string) => Promise<CentralAuthUser | null>;
  onPresence?: (snapshot: TeamPresenceSnapshot) => void;
  chat?: TeamChatStore;
  onDirectMessage?: (event: DirectMessageRealtimeEvent) => void;
  onDirectTyping?: (event: DirectTypingRealtimeEvent) => void;
  createInvite?: (input: CreateTeamInviteInput) => Promise<InviteSummary>;
  onSessionRevoked?: (sessionId: string) => Promise<void> | void;
  rateLimitCapacity?: number;
  now?: () => number;
  logger?: Logger;
}
