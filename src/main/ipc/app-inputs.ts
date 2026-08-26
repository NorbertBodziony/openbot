import type {
  AgentProviderId,
  ExternalDestination,
  MacPermissionId,
  SetAnalyticsPreferenceInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";

export function parseProvider(input: unknown): AgentProviderId {
  if (!isDynamicRecord(input)) throw new Error("Setup input is required.");
  const provider = input.preferredProvider;
  if (provider !== "codex" && provider !== "claude" && provider !== "grok") throw new Error("Unknown provider.");
  return provider;
}

export function parseAnalyticsPreference(input: unknown): SetAnalyticsPreferenceInput {
  if (!isDynamicRecord(input) || !isBoolean(input.enabled)) throw new Error("Analytics preference is required.");
  return { enabled: input.enabled };
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
