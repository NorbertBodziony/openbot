import type { AgentApprovalKind, AgentApprovalPermissions, BotAvatarHue } from "./ipc-conversation";

export type DynamicIslandMode = "idle" | "working" | "message" | "question" | "approval";

export interface DynamicIslandPreference {
  enabled: boolean;
}

export interface SetDynamicIslandPreferenceInput {
  enabled: boolean;
}

export interface DynamicIslandBotIdentity {
  id: string;
  name: string;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
}

export interface DynamicIslandWorkingItem {
  bot: DynamicIslandBotIdentity;
  task: string;
}

export interface DynamicIslandMessageItem {
  bot: DynamicIslandBotIdentity;
  messageId: string;
  text: string;
  createdAt: string;
}

export interface DynamicIslandQuestionItem {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface DynamicIslandAttentionItem {
  id: string;
  requestId: string | number;
  bot: DynamicIslandBotIdentity;
  kind: "prompt" | "approval";
  title: string;
  detail: string | null;
  options: Array<{ label: string; description: string }> | null;
  questions: DynamicIslandQuestionItem[] | null;
  approval: {
    kind: AgentApprovalKind;
    command: string | null;
    cwd: string | null;
    reason: string | null;
    grantRoot: string | null;
    permissions: AgentApprovalPermissions | null;
  } | null;
}

export interface DynamicIslandPresentation {
  serverId: string;
  mode: DynamicIslandMode;
  activeCount: number;
  unreadCount: number;
  attentionCount: number;
  working: DynamicIslandWorkingItem[];
  message: DynamicIslandMessageItem | null;
  attention: DynamicIslandAttentionItem[];
}

export type DynamicIslandAction =
  | { type: "open-app" }
  | { type: "open-bot"; serverId: string; botId: string }
  | { type: "open-message"; serverId: string; botId: string; messageId: string }
  | { type: "review-attention"; serverId: string; botId: string; requestId: string | number }
  | { type: "approve-attention"; serverId: string; botId: string; requestId: string | number }
  | {
      type: "answer-prompt";
      serverId: string;
      botId: string;
      requestId: string | number;
      answers: Record<string, string[]>;
    };

export interface SetDynamicIslandInteractiveInput {
  interactive: boolean;
}
