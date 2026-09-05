import { INPUT_LIMITS } from "./input-limits";
import {
  type AgentModelId,
  type AgentReasoningEffort,
  type AvatarHue,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isReasoningEffort,
} from "./ipc-agent-identity";
import { type AgentProviderId, isAgentProvider } from "./ipc-agent-status";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import type { SidebarLayoutSnapshot } from "./ipc-sidebar-layout";
import { isBoolean, isDynamicRecord, isNumber } from "./runtime-values";

function isMarketplaceSource(value: unknown): value is NonNullable<AgentSummary["marketplaceSource"]> {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.listingId) &&
    isIdentifier(value.versionId) &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    Array.isArray(value.skillIds) &&
    value.skillIds.length <= INPUT_LIMITS.agents &&
    value.skillIds.every(isIdentifier) &&
    Array.isArray(value.routineIds) &&
    value.routineIds.length <= INPUT_LIMITS.agentRoutines &&
    value.routineIds.every(isIdentifier)
  );
}

export interface AgentSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
  marketplaceSource?: {
    listingId: string;
    versionId: string;
    version: number;
    skillIds: string[];
    routineIds: string[];
  };
}

export function isAgentSummary(value: unknown): value is AgentSummary {
  if (!isDynamicRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    isBoundedString(value.title, INPUT_LIMITS.agentTitle) &&
    isBoundedString(value.description, INPUT_LIMITS.agentDescription) &&
    isBoolean(value.notifications) &&
    isAgentProvider(value.provider) &&
    isAgentModel(value.model) &&
    isReasoningEffort(value.reasoningEffort) &&
    (value.threadId === null || isIdentifier(value.threadId)) &&
    isBoundedString(value.workspacePath, INPUT_LIMITS.path) &&
    isBoundedString(value.preview, INPUT_LIMITS.messageText) &&
    (value.updatedAt === null || isBoundedString(value.updatedAt, 160)) &&
    isAvatarSeed(value.avatarSeed) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isBoundedString(value.avatarUrl, INPUT_LIMITS.avatarUrl)) &&
    (value.marketplaceSource === undefined || isMarketplaceSource(value.marketplaceSource))
  );
}

export interface CreateAgentInput {
  name: string;
  description: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  initialMessage: string;
}

export interface UpdateAgentInput {
  agentId: string;
  name?: string;
  title?: string;
  description?: string;
  notifications?: boolean;
  provider?: AgentProviderId;
  model?: AgentModelId;
  reasoningEffort?: AgentReasoningEffort;
  avatarSeed?: string;
  avatarHue?: AvatarHue | null;
}

export interface DuplicateAgentResult {
  agent: AgentSummary;
  layout: SidebarLayoutSnapshot;
}

export interface AvatarImageInput {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}

export interface SetAgentAvatarInput {
  agentId: string;
  image: AvatarImageInput | null;
}
