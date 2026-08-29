import type {
  AgentProviderId,
  DynamicIslandAction,
  DynamicIslandPresentation,
  ExternalDestination,
  MacPermissionId,
  SetAnalyticsPreferenceInput,
} from "@openbot/contracts/ipc";
import {
  isDynamicIslandAction,
  isDynamicIslandInteractive,
  isDynamicIslandPreference,
  isDynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";

export function parseProvider(input: unknown): AgentProviderId {
  if (!isDynamicRecord(input)) throw new Error("Setup input is required.");
  const provider = input.preferredProvider;
  if (provider !== "codex" && provider !== "claude" && provider !== "grok") throw new Error("Unknown provider.");
  return provider;
}

export function parseProviderId(input: unknown): AgentProviderId {
  if (input !== "codex" && input !== "claude" && input !== "grok") throw new Error("Unknown provider.");
  return input;
}

export function parseAnalyticsPreference(input: unknown): SetAnalyticsPreferenceInput {
  if (!isDynamicRecord(input) || !isBoolean(input.enabled)) throw new Error("Analytics preference is required.");
  return { enabled: input.enabled };
}

export function parseDynamicIslandPreference(input: unknown): { enabled: boolean } {
  if (!isDynamicIslandPreference(input)) {
    throw new Error("Dynamic Island preference is required.");
  }
  return input;
}

export function parseDynamicIslandInteractive(input: unknown): { interactive: boolean } {
  if (!isDynamicIslandInteractive(input)) {
    throw new Error("Dynamic Island interaction state is required.");
  }
  return input;
}

export function parseDynamicIslandPresentation(input: unknown): DynamicIslandPresentation {
  if (!isDynamicIslandPresentation(input)) throw new Error("Dynamic Island presentation is invalid.");
  return input;
}

export function parseDynamicIslandAction(input: unknown): DynamicIslandAction {
  if (isDynamicIslandAction(input)) return input;
  throw new Error("Dynamic Island action is invalid.");
}

export function parseMacPermission(input: unknown): MacPermissionId {
  if (input !== "screen-recording" && input !== "accessibility") {
    throw new Error("Unknown macOS permission.");
  }
  return input;
}

export function parseExternalDestination(input: unknown): ExternalDestination {
  if (
    input !== "agent-setup" &&
    input !== "claude-install" &&
    input !== "claude-sign-in" &&
    input !== "feedback" &&
    input !== "message"
  ) {
    throw new Error("Unknown external destination.");
  }
  return input;
}
