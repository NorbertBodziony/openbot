import { INPUT_LIMITS } from "./input-limits";
import { type AvatarHue, isAvatarHue, isAvatarSeed } from "./ipc-agent-identity";
import {
  type AgentApproval,
  type AgentApprovalPermissions,
  type BrowserTakeoverRequest,
  isBrowserTakeoverRequest,
} from "./ipc-approvals";
import { isBoundedString, isIdentifier, isNullableBoundedString, isRequestId } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

export const AGENT_RUNTIME_TEXT_LIMIT = 240;
export const AGENT_RUNTIME_QUESTION_HEADER_LIMIT = 80;
export const AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT = 120;
export const AGENT_RUNTIME_WORKING_ITEMS_LIMIT = 3;
export const AGENT_RUNTIME_ATTENTION_LIMIT = 4;
export const AGENT_RUNTIME_PERMISSION_PATHS_LIMIT = 3;
export const AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT = 256 * 1024;

export interface AgentRuntimeRosterEntry {
  id: string;
  name: string;
  notifications: boolean;
  preview: string;
  updatedAt: string | null;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
}

function isAgentRuntimeRosterEntry(value: unknown): value is AgentRuntimeRosterEntry {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    isBoolean(value.notifications) &&
    isBoundedString(value.preview, AGENT_RUNTIME_TEXT_LIMIT) &&
    (value.updatedAt === null || isBoundedString(value.updatedAt, 160)) &&
    isAvatarSeed(value.avatarSeed) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isBoundedString(value.avatarUrl, INPUT_LIMITS.avatarUrl))
  );
}

export interface AgentRuntimeWorkItem {
  id: string;
  agentId: string;
  turnId: string | null;
  status: "starting" | "running" | "failed";
  text: string;
  error: string | null;
}

function isRuntimeWorkItem(value: unknown): value is AgentRuntimeWorkItem {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.agentId) &&
    (value.turnId === null || isIdentifier(value.turnId)) &&
    isOneOf(["starting", "running", "failed"] as const, value.status) &&
    isBoundedString(value.text, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.error, AGENT_RUNTIME_TEXT_LIMIT)
  );
}

export interface AgentRuntimePromptQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

function isRuntimePromptQuestion(value: unknown): value is AgentRuntimePromptQuestion {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.header, AGENT_RUNTIME_QUESTION_HEADER_LIMIT) &&
    isBoundedString(value.question, AGENT_RUNTIME_TEXT_LIMIT) &&
    isBoolean(value.isSecret) &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.length <= INPUT_LIMITS.promptOptions &&
        value.options.every(
          (option) =>
            isDynamicRecord(option) &&
            isBoundedString(option.label, INPUT_LIMITS.promptOptionLabel) &&
            isBoundedString(option.description, AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT),
        )))
  );
}

export interface AgentRuntimeApproval extends AgentApproval {
  truncated: boolean;
}

function isRuntimeApproval(value: unknown): value is AgentRuntimeApproval {
  if (!isDynamicRecord(value)) return false;
  return (
    isRequestId(value.requestId) &&
    isIdentifier(value.agentId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    isOneOf(["command", "file-change", "permissions"] as const, value.kind) &&
    isNullableBoundedString(value.command, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.cwd, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.reason, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.grantRoot, AGENT_RUNTIME_TEXT_LIMIT) &&
    isBoolean(value.truncated) &&
    (value.permissions === null || isRuntimeApprovalPermissions(value.permissions))
  );
}

// The twin of `isAgentApprovalPermissions` in `ipc-approvals.ts`, bounded by the snapshot's tighter
// limits instead of the IPC ones. Kept apart on purpose: merging them onto either bound would either
// let a snapshot exceed its byte cap or reject a legitimate full approval.
function isRuntimeApprovalPermissions(value: unknown): value is AgentApprovalPermissions {
  return (
    isDynamicRecord(value) &&
    isDynamicRecord(value.fileSystem) &&
    isRuntimePathList(value.fileSystem.read) &&
    isRuntimePathList(value.fileSystem.write) &&
    isBoolean(value.network)
  );
}

function isRuntimePathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= AGENT_RUNTIME_PERMISSION_PATHS_LIMIT &&
    value.every((path) => isBoundedString(path, AGENT_RUNTIME_TEXT_LIMIT))
  );
}

export interface AgentRuntimeSnapshot {
  agents: AgentRuntimeRosterEntry[];
  activeTurns: Array<{ agentId: string; threadId: string; turnId: string }>;
  work: AgentRuntimeWorkItem[];
  latestMessages: Array<{ agentId: string; id: string; text: string; createdAt: string }>;
  attentionComplete: boolean;
  pendingPrompts: Array<{
    requestId: string | number;
    agentId: string;
    threadId: string;
    turnId: string;
    questions: AgentRuntimePromptQuestion[];
  }>;
  pendingApprovals: AgentRuntimeApproval[];
  pendingBrowserTakeovers: BrowserTakeoverRequest[];
  failedTurns: Array<{ agentId: string; turnId: string }>;
}

export function isAgentRuntimeSnapshot(value: unknown): value is AgentRuntimeSnapshot {
  if (!isDynamicRecord(value)) return false;
  return (
    Array.isArray(value.agents) &&
    value.agents.length <= INPUT_LIMITS.agents &&
    value.agents.every(isAgentRuntimeRosterEntry) &&
    Array.isArray(value.activeTurns) &&
    value.activeTurns.length <= INPUT_LIMITS.agents &&
    value.activeTurns.every(
      (turn) =>
        isDynamicRecord(turn) && isIdentifier(turn.agentId) && isIdentifier(turn.threadId) && isIdentifier(turn.turnId),
    ) &&
    Array.isArray(value.work) &&
    value.work.length <= AGENT_RUNTIME_WORKING_ITEMS_LIMIT + AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.work.every(isRuntimeWorkItem) &&
    Array.isArray(value.latestMessages) &&
    value.latestMessages.length <= INPUT_LIMITS.agents &&
    value.latestMessages.every(
      (message) =>
        isDynamicRecord(message) &&
        isIdentifier(message.agentId) &&
        isIdentifier(message.id) &&
        isBoundedString(message.text, AGENT_RUNTIME_TEXT_LIMIT) &&
        isBoundedString(message.createdAt, 160),
    ) &&
    isBoolean(value.attentionComplete) &&
    Array.isArray(value.pendingPrompts) &&
    value.pendingPrompts.length <= AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.pendingPrompts.every(isRuntimePrompt) &&
    Array.isArray(value.pendingApprovals) &&
    value.pendingApprovals.length <= AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.pendingApprovals.every(isRuntimeApproval) &&
    Array.isArray(value.pendingBrowserTakeovers) &&
    value.pendingBrowserTakeovers.length <= AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.pendingBrowserTakeovers.every(isBrowserTakeoverRequest) &&
    value.pendingPrompts.length + value.pendingApprovals.length + value.pendingBrowserTakeovers.length <=
      AGENT_RUNTIME_ATTENTION_LIMIT &&
    Array.isArray(value.failedTurns) &&
    value.failedTurns.length <= INPUT_LIMITS.agents &&
    value.failedTurns.every((turn) => isDynamicRecord(turn) && isIdentifier(turn.agentId) && isIdentifier(turn.turnId))
  );
}

function isRuntimePrompt(value: unknown): value is AgentRuntimeSnapshot["pendingPrompts"][number] {
  return (
    isDynamicRecord(value) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.agentId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    Array.isArray(value.questions) &&
    value.questions.length <= INPUT_LIMITS.promptQuestions &&
    value.questions.every(isRuntimePromptQuestion)
  );
}
