// `isAgentEvent` is the one guard that reaches across every domain in this package: an agent event
// is a union over the payloads the other modules own. It imports their guards rather than restating
// their rules, which is what lets each guard live beside the type it validates.

import { INPUT_LIMITS } from "./input-limits";
import { type AgentRuntimeSnapshot, isAgentRuntimeSnapshot } from "./ipc-agent-runtime";
import type { AccountUsage, AgentStatus } from "./ipc-agent-status";
import { type AgentSummary, isAgentSummary } from "./ipc-agents";
import {
  type AgentApproval,
  type BrowserTakeoverRequest,
  isAgentApproval,
  isBrowserTakeoverRequest,
} from "./ipc-approvals";
import { isIdentifier } from "./ipc-bounded-values";
import type { BrowserControlState, BrowserTab } from "./ipc-browser";
import { type AgentPromptQuestion, isAgentPromptQuestion, isConversationMessage } from "./ipc-conversation-messages";
import {
  type ConversationPage,
  type ConversationSnapshot,
  isConversationReadState,
  isConversationSnapshot,
} from "./ipc-conversations";
import { isQueueSnapshot, type QueueSnapshot } from "./ipc-queue";
import { isSidebarLayoutSnapshot, type SidebarLayoutSnapshot } from "./ipc-sidebar-layout";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";

export type AgentTurnOrigin = "user" | "routine" | "agent" | "unknown";

function isAgentTurnOrigin(value: unknown): value is AgentTurnOrigin {
  return value === "user" || value === "routine" || value === "agent" || value === "unknown";
}

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "usage-changed"; usage: AccountUsage }
  | { type: "agents-changed"; agents: AgentSummary[] }
  | { type: "memories-changed"; agentId: string }
  | { type: "routines-changed"; agentId: string }
  | { type: "sidebar-layout-changed"; layout: SidebarLayoutSnapshot }
  | { type: "conversation"; snapshot: ConversationSnapshot }
  | { type: "conversation-invalidated"; agentId: string; revision: number }
  | { type: "conversation-page"; page: ConversationPage }
  | {
      type: "conversation-delta";
      agentId: string;
      threadId: string;
      turnId: string;
      messageId: string;
      delta: string;
      createdAt: string;
      revision: number;
    }
  | { type: "queue-invalidated"; agentId: string }
  | { type: "queue-changed"; snapshot: QueueSnapshot }
  | { type: "turn-progress"; agentId: string; threadId: string; turnId: string; detail: string }
  | { type: "turn-started"; agentId: string; threadId: string; turnId: string; origin?: AgentTurnOrigin }
  | {
      type: "turn-completed";
      agentId: string;
      threadId: string;
      turnId: string;
      status: string;
      origin?: AgentTurnOrigin;
    }
  | {
      type: "prompt";
      requestId: string | number;
      agentId: string;
      threadId: string;
      turnId: string;
      questions: AgentPromptQuestion[];
    }
  | {
      type: "agent-input-resolved";
      kind: "prompt" | "approval";
      requestId: string | number;
      agentId: string;
    }
  | { type: "browser-takeover-requested"; request: BrowserTakeoverRequest }
  | { type: "browser-takeover-resolved"; requestId: string | number; agentId: string }
  | { type: "approval"; approval: AgentApproval }
  | { type: "runtime-snapshot"; snapshot: AgentRuntimeSnapshot }
  | { type: "browser-changed"; tabs: BrowserTab[]; activeTabId: string | null }
  | { type: "browser-control-changed"; state: BrowserControlState }
  | { type: "error"; agentId?: string; code: string; message: string };

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isDynamicRecord(value) || !isString(value.type)) return false;
  switch (value.type) {
    case "status":
      return isDynamicRecord(value.status);
    case "usage-changed":
      return isDynamicRecord(value.usage);
    case "agents-changed":
      return (
        Array.isArray(value.agents) && value.agents.length <= INPUT_LIMITS.agents && value.agents.every(isAgentSummary)
      );
    case "memories-changed":
      return isString(value.agentId) && value.agentId.length > 0 && value.agentId.length <= INPUT_LIMITS.identifier;
    case "routines-changed":
      return isString(value.agentId) && value.agentId.length > 0 && value.agentId.length <= INPUT_LIMITS.identifier;
    case "sidebar-layout-changed":
      return isSidebarLayoutSnapshot(value.layout);
    case "conversation":
      return isConversationSnapshot(value.snapshot);
    case "conversation-invalidated":
      return (
        isIdentifier(value.agentId) &&
        isNumber(value.revision) &&
        Number.isInteger(value.revision) &&
        value.revision >= 0
      );
    case "conversation-page": {
      const page = value.page;
      if (!isDynamicRecord(page)) return false;
      const references = page.references;
      const pageInfo = page.pageInfo;
      const readState = page.readState;
      return (
        isConversationSnapshot(page) &&
        page.messages.length <= 100 &&
        isDynamicRecord(references) &&
        Object.values(references).every(isConversationMessage) &&
        isDynamicRecord(pageInfo) &&
        isBoolean(pageInfo.hasOlder) &&
        (pageInfo.olderCursor === null || isString(pageInfo.olderCursor)) &&
        (readState === undefined || isConversationReadState(readState))
      );
    }
    case "conversation-delta":
      return (
        isString(value.agentId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        isString(value.messageId) &&
        isString(value.delta) &&
        isString(value.createdAt) &&
        isNumber(value.revision)
      );
    case "queue-invalidated":
      return isIdentifier(value.agentId);
    case "queue-changed":
      return isQueueSnapshot(value.snapshot);
    case "turn-progress":
      return (
        isIdentifier(value.agentId) &&
        isIdentifier(value.threadId) &&
        isIdentifier(value.turnId) &&
        isString(value.detail) &&
        value.detail.length > 0 &&
        value.detail.length <= INPUT_LIMITS.promptQuestion
      );
    case "turn-started":
    case "turn-completed":
      return (
        isString(value.agentId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        (value.origin === undefined || isAgentTurnOrigin(value.origin))
      );
    case "prompt":
      return (
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.agentId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        Array.isArray(value.questions) &&
        value.questions.length <= INPUT_LIMITS.promptQuestions &&
        value.questions.every(isAgentPromptQuestion)
      );
    case "agent-input-resolved":
      return (
        (value.kind === "prompt" || value.kind === "approval") &&
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.agentId)
      );
    case "browser-takeover-requested":
      return isBrowserTakeoverRequest(value.request);
    case "browser-takeover-resolved":
      return (isString(value.requestId) || isNumber(value.requestId)) && isString(value.agentId);
    case "approval":
      return isAgentApproval(value.approval);
    case "runtime-snapshot":
      return isAgentRuntimeSnapshot(value.snapshot);
    case "browser-changed":
      return Array.isArray(value.tabs) && (value.activeTabId === null || isString(value.activeTabId));
    case "browser-control-changed":
      return isDynamicRecord(value.state);
    case "error":
      return isString(value.code) && isString(value.message);
    default:
      return false;
  }
}

export interface ScopedAgentEvent {
  serverId: string;
  event: AgentEvent;
  bufferedLive?: boolean;
}

export interface AgentIpcRequest<T = unknown> {
  serverId: string;
  payload: T;
}
