import { INPUT_LIMITS } from "./input-limits";
import { type AgentProviderId, isAgentProvider } from "./ipc-agent-status";
import { isBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf, isString } from "./runtime-values";

export type AgentModelId = string;

export const AGENT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export const AVATAR_HUES = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320] as const;
export type AvatarHue = (typeof AVATAR_HUES)[number];

export function isAgentModel(value: unknown): value is AgentModelId {
  return isString(value) && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export function isClaudeModel(model: AgentModelId): boolean {
  return model.startsWith("claude-");
}

export function providerForLegacyModel(model: AgentModelId): AgentProviderId {
  if (isClaudeModel(model)) return "claude";
  if (model.startsWith("grok-")) return "grok";
  return "codex";
}

export function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return isOneOf(AGENT_REASONING_EFFORTS, value);
}

export function isAvatarSeed(value: unknown): value is string {
  return isString(value) && /^[a-z0-9:-]{1,128}$/.test(value);
}

export function isAvatarHue(value: unknown): value is AvatarHue {
  return isOneOf(AVATAR_HUES, value);
}

export interface AgentModelOption {
  provider: AgentProviderId;
  id: AgentModelId;
  name: string;
  description: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: AgentReasoningEffort[];
}

export function isAgentModelOption(value: unknown): value is AgentModelOption {
  return (
    isDynamicRecord(value) &&
    isAgentProvider(value.provider) &&
    isAgentModel(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.modelName) &&
    isBoundedString(value.description, INPUT_LIMITS.agentDescription) &&
    isReasoningEffort(value.defaultReasoningEffort) &&
    Array.isArray(value.supportedReasoningEfforts) &&
    value.supportedReasoningEfforts.every(isReasoningEffort)
  );
}
